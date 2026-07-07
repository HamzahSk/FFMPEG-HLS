import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URLSTREAM, MAX_CONCURRENCY } from "./config.js";

const exec = promisify(execFile);

// Helper untuk men-generate headers
function getHeaders(url) {
    const origin = new URL(url).origin;
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'Referer': origin,
        'Origin': origin
    };
}

// Mencari URL m3u8 dengan resolusi paling tinggi
async function getMediaPlaylist(url) {
    const headers = getHeaders(url);
    const res = await fetch(url, { headers });

    if (!res.ok) throw new Error(`Gagal mengambil playlist dari ${url} (Status: ${res.status})`);

    const text = await res.text();

    if (!text.includes("#EXT-X-STREAM-INF")) {
        return url; // Sudah merupakan media playlist
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
    console.log(`\n[Info] Menganalisis stream: ${url}`);
    
    // Dapatkan URL playlist resolusi tertinggi
    const playlist = await getMediaPlaylist(url);
    const headObj = getHeaders(playlist);
    
    // Format header khusus agar dibaca oleh FFmpeg
    const ffmpegHeaders = `User-Agent: ${headObj['User-Agent']}\r\nReferer: ${headObj['Referer']}\r\nOrigin: ${headObj['Origin']}\r\n`;

    console.log(`[Download] Memulai proses download & decrypt via FFmpeg ke ${output}...`);

    // Biarkan FFmpeg yang handle download agar enkripsi (AES) otomatis ter-decrypt
    await exec("ffmpeg", [
        "-y",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
        "-headers", ffmpegHeaders,
        "-multiple_requests", "1", // Mempercepat koneksi HTTP di FFmpeg
        "-i", playlist,
        "-c:v", "libx264",         // Format video standar WA
        "-preset", "fast",
        "-crf", "26",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",             // Format audio standar WA
        "-b:a", "128k",
        "-bsf:a", "aac_adtstoasc",
        output
    ]);

    console.log(`[Selesai] Video tersimpan: ${output}`);
}

async function startJob() {
    for (let i = 0; i < URLSTREAM.length; i += MAX_CONCURRENCY) {
        const chunk = URLSTREAM.slice(i, i + MAX_CONCURRENCY);
        
        console.log(`\n=== Memproses Batch: ${i + 1} s/d ${i + chunk.length} ===`);
        
        // Memproses beberapa URL video (misal 5 URL) secara bersamaan
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
