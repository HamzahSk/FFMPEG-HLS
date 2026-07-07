import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { URLSTREAM, MAX_CONCURRENCY } from "./config.js";

const exec = promisify(execFile);

function getHeaders(url) {
    const origin = new URL(url).origin;
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': origin,
        'Origin': origin
    };
}

async function getMediaPlaylist(url) {
    const headers = getHeaders(url);
    const res = await fetch(url, { headers });

    if (!res.ok) throw new Error(`Gagal mengambil playlist (Status: ${res.status})`);

    const text = await res.text();
    if (!text.includes("#EXT-X-STREAM-INF")) return { url, content: text }; // Sudah media playlist

    const lines = text.split(/\r?\n/);
    let best = null;

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
        const match = lines[i].match(/RESOLUTION=\d+x(\d+)/);
        const height = match ? Number(match[1]) : 0;

        if (!best || height > best.height) {
            best = { height, url: new URL(lines[i + 1], url).href };
        }
    }

    if (!best) throw new Error("Media playlist tidak ditemukan");
    
    // Ambil konten dari playlist resolusi terbaik
    const bestRes = await fetch(best.url, { headers });
    return { url: best.url, content: await bestRes.text() };
}

async function downloadHLS(url, output) {
    console.log(`\n[Info] Menganalisis stream: ${url}`);
    const { url: mediaUrl, content } = await getMediaPlaylist(url);
    const headers = getHeaders(mediaUrl);

    // 1. Ekstrak semua URL segmen (.ts)
    const lines = content.split(/\r?\n/);
    const segments = lines
        .filter(line => line.trim() && !line.startsWith("#"))
        .map(line => new URL(line, mediaUrl).href);

    if (segments.length === 0) throw new Error("Tidak ada segmen video yang ditemukan.");
    console.log(`[Download] Ditemukan ${segments.length} segmen. Memulai download paralel...`);

    // 2. Siapkan folder sementara (temp)
    const tempDir = path.resolve(`./temp_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
    await mkdir(tempDir, { recursive: true });
    
    const segmentFiles = [];
    const maxSegmentConcurrency = 10; // Maksimal 10 segmen diunduh bersamaan

    // 3. Download segmen secara paralel (Batching)
    for (let i = 0; i < segments.length; i += maxSegmentConcurrency) {
        const chunk = segments.slice(i, i + maxSegmentConcurrency);
        
        const promises = chunk.map(async (segUrl, idx) => {
            const segIndex = i + idx;
            const filePath = path.join(tempDir, `seg_${segIndex}.ts`);
            
            // Retry sederhana jika gagal download segmen
            for(let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const res = await fetch(segUrl, { headers });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const buffer = await res.arrayBuffer();
                    await writeFile(filePath, Buffer.from(buffer));
                    return filePath;
                } catch (err) {
                    if (attempt === 3) throw new Error(`Gagal unduh segmen ${segIndex} setelah 3 kali coba.`);
                }
            }
        });

        // Tunggu maksimal 10 download ini selesai sebelum lanjut ke 10 berikutnya
        const downloadedPaths = await Promise.all(promises);
        segmentFiles.push(...downloadedPaths);
        
        const progress = Math.round((segmentFiles.length / segments.length) * 100);
        process.stdout.write(`\r[Proses] Mengunduh segmen: ${progress}% (${segmentFiles.length}/${segments.length})`);
    }
    console.log(""); // baris baru setelah progress selesai

    // 4. Buat file list.txt untuk FFmpeg concat
    const concatList = segmentFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
    const concatListPath = path.join(tempDir, 'list.txt');
    await writeFile(concatListPath, concatList);

    console.log(`[Encode] Menggabungkan dan convert ke WA format...`);

    // 5. Eksekusi FFmpeg menggunakan file teks concat
    await exec("ffmpeg", [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatListPath,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "26",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        output
    ]);

    // 6. Bersihkan folder sementara
    await rm(tempDir, { recursive: true, force: true });
    
    console.log(`[Selesai] Video tersimpan: ${output}`);
}

async function startJob() {
    for (let i = 0; i < URLSTREAM.length; i += MAX_CONCURRENCY) {
        const chunk = URLSTREAM.slice(i, i + MAX_CONCURRENCY);
        console.log(`\n=== Memproses Batch Video: ${i + 1} s/d ${i + chunk.length} ===`);
        
        const promises = chunk.map((url, index) => {
            const fileName = `video_output_${i + index + 1}.mp4`;
            return downloadHLS(url, fileName).catch(err => {
                console.error(`\n[Error] Gagal memproses ${url}:`, err.message);
            });
        });

        await Promise.all(promises);
    }
    console.log("\n=== Semua proses selesai! ===");
}

startJob();
