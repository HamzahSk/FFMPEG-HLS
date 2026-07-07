import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URLSTREAM, MAX_CONCURRENCY } from "./config.js";

const exec = promisify(execFile);

// Helper untuk men-generate headers berdasarkan URL base
function getHeaders(url) {
    const origin = new URL(url).origin;
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'Referer': origin,
        'Origin': origin
    };
}

async function getMediaPlaylist(url) {
    const headers = getHeaders(url);
    const res = await fetch(url, { headers });

    if (!res.ok) throw new Error(`Gagal mengambil playlist dari ${url} (Status: ${res.status})`);

    const text = await res.text();

    if (!text.includes("#EXT-X-STREAM-INF")) {
        return url; // Sudah merupakan master playlist
    }

    const lines = text.split(/\r?\n/);
    let best = null;

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;

        const info = lines[i];
        const next = lines[i + 1];

        const match = info.match(/RESOLUTION=\d+x(\d+)/);
        const height = match ? Number(match[1]) : 0;

        if (!best || height > best.height) {
            best = {
                height,
                url: new URL(next, url).href
            };
        }
    }

    if (!best) throw new Error("Media playlist tidak ditemukan");

    return best.url;
}

async function downloadHLS(url, output) {
    console.log(`[Memproses] Mencari resolusi terbaik untuk: ${url}`);
    const playlist = await getMediaPlaylist(url);
    
    const headObj = getHeaders(url);
    // Format header untuk FFmpeg (harus dipisah dengan \r\n)
    const ffmpegHeaders = `User-Agent: ${headObj['User-Agent']}\r\nReferer: ${headObj['Referer']}\r\nOrigin: ${headObj['Origin']}\r\n`;

    console.log(`[Download] Memulai download ke ${output}...`);

    await exec("ffmpeg", [
        "-y",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
        "-headers", ffmpegHeaders, // Masukkan header ke FFmpeg
        "-i", playlist,
        "-c:v", "libx264",         // Encode video ke H.264 (Support WA)
        "-preset", "fast",         // Kecepatan proses (bisa ganti ke 'ultrafast' jika ingin cepat tapi file lebih besar)
        "-crf", "26",              // Kualitas video (semakin kecil = semakin bagus tapi besar. 26 standar WA)
        "-pix_fmt", "yuv420p",     // Wajib untuk support mobile / WA
        "-c:a", "aac",             // Encode audio ke AAC (Support WA)
        "-b:a", "128k",            // Bitrate audio
        "-bsf:a", "aac_adtstoasc",
        output
    ]);

    console.log(`[Selesai] Video tersimpan: ${output}`);
}

async function startJob() {
    // Memproses URLSTREAM dengan batasan concurrency
    for (let i = 0; i < URLSTREAM.length; i += MAX_CONCURRENCY) {
        const chunk = URLSTREAM.slice(i, i + MAX_CONCURRENCY);
        
        console.log(`\n=== Memproses Batch: ${i + 1} s/d ${i + chunk.length} ===`);
        
        const promises = chunk.map((url, index) => {
            const fileName = `video_output_${i + index + 1}.mp4`;
            return downloadHLS(url, fileName).catch(err => {
                console.error(`[Error] Gagal memproses ${url}:`, err.message);
            });
        });

        // Tunggu semua proses di batch ini selesai sebelum lanjut ke batch berikutnya
        await Promise.all(promises);
    }
    
    console.log("\n=== Semua proses selesai! ===");
}

startJob();
