/**
 * Embed Camera Utilities
 * Fungsi untuk menangani kamera embed (streaming only, no recording)
 */

/**
 * Deteksi tipe embed dari URL
 * @param {string} url - URL embed
 * @returns {string} - Tipe embed: 'youtube', 'iframe', 'hls', 'dash', 'custom'
 */
function detectEmbedType(url) {
    if (!url) return 'custom';
    
    const urlLower = url.toLowerCase();
    
    // YouTube Live
    if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) {
        return 'youtube';
    }
    
    // HLS stream (.m3u8)
    if (urlLower.includes('.m3u8')) {
        return 'hls';
    }
    
    // DASH stream (.mpd)
    if (urlLower.includes('.mpd')) {
        return 'dash';
    }
    
    // Generic iframe
    if (urlLower.includes('iframe') || urlLower.includes('embed')) {
        return 'iframe';
    }
    
    return 'custom';
}

/**
 * Generate embed HTML berdasarkan tipe
 * @param {object} camera - Camera object dari database
 * @returns {string} - HTML embed code
 */
function generateEmbedHtml(camera) {
    if (!camera.embed_url) {
        return '<div class="text-red-500">No embed URL configured</div>';
    }
    
    const embedType = camera.embed_type || detectEmbedType(camera.embed_url);
    
    switch (embedType) {
        case 'youtube':
            return generateYouTubeEmbed(camera.embed_url);
        
        case 'hls':
            return generateHlsEmbed(camera.embed_url, camera.id);
        
        case 'dash':
            return generateDashEmbed(camera.embed_url, camera.id);
        
        case 'iframe':
            return generateIframeEmbed(camera.embed_url);
        
        default:
            return generateCustomEmbed(camera.embed_url);
    }
}

/**
 * Generate YouTube embed
 */
function generateYouTubeEmbed(url) {
    // Extract video ID from various YouTube URL formats
    let videoId = '';
    
    if (url.includes('youtube.com/watch?v=')) {
        videoId = url.split('v=')[1]?.split('&')[0];
    } else if (url.includes('youtube.com/embed/')) {
        videoId = url.split('embed/')[1]?.split('?')[0];
    } else if (url.includes('youtu.be/')) {
        videoId = url.split('youtu.be/')[1]?.split('?')[0];
    }
    
    if (!videoId) {
        return `<iframe src="${url}" frameborder="0" allowfullscreen class="w-full h-full"></iframe>`;
    }
    
    return `
        <iframe 
            src="https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=1" 
            frameborder="0" 
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
            allowfullscreen 
            class="w-full h-full">
        </iframe>
    `;
}

/**
 * Generate HLS embed (menggunakan hls.js)
 */
function generateHlsEmbed(url, cameraId) {
    return `
        <video id="embed-hls-${cameraId}" class="w-full h-full" controls autoplay muted></video>
        <script>
            (function() {
                const video = document.getElementById('embed-hls-${cameraId}');
                const hlsUrl = '${url}';
                
                if (Hls.isSupported()) {
                    const hls = new Hls({
                        enableWorker: true,
                        lowLatencyMode: true,
                        backBufferLength: 90
                    });
                    hls.loadSource(hlsUrl);
                    hls.attachMedia(video);
                    hls.on(Hls.Events.MANIFEST_PARSED, function() {
                        video.play().catch(e => console.log('Autoplay prevented:', e));
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = hlsUrl;
                    video.addEventListener('loadedmetadata', function() {
                        video.play().catch(e => console.log('Autoplay prevented:', e));
                    });
                }
            })();
        </script>
    `;
}

/**
 * Generate DASH embed (menggunakan dash.js)
 */
function generateDashEmbed(url, cameraId) {
    return `
        <video id="embed-dash-${cameraId}" class="w-full h-full" controls autoplay muted></video>
        <script src="https://cdn.dashjs.org/latest/dash.all.min.js"></script>
        <script>
            (function() {
                const video = document.getElementById('embed-dash-${cameraId}');
                const player = dashjs.MediaPlayer().create();
                player.initialize(video, '${url}', true);
            })();
        </script>
    `;
}

/**
 * Generate generic iframe embed
 */
function generateIframeEmbed(url) {
    return `
        <iframe 
            src="${url}" 
            frameborder="0" 
            allowfullscreen 
            class="w-full h-full">
        </iframe>
    `;
}

/**
 * Generate custom embed (fallback)
 */
function generateCustomEmbed(url) {
    return `
        <div class="flex items-center justify-center h-full bg-gray-800 text-white">
            <div class="text-center">
                <p class="mb-4">Custom Embed URL:</p>
                <a href="${url}" target="_blank" class="text-blue-400 hover:underline break-all">${url}</a>
            </div>
        </div>
    `;
}

/**
 * Validasi URL embed
 * @param {string} url - URL to validate
 * @returns {object} - {valid: boolean, message: string}
 */
function validateEmbedUrl(url) {
    if (!url || url.trim() === '') {
        return { valid: false, message: 'URL embed tidak boleh kosong' };
    }
    
    // Basic URL validation
    try {
        new URL(url);
    } catch (e) {
        return { valid: false, message: 'Format URL tidak valid' };
    }
    
    // Check for supported protocols
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { valid: false, message: 'URL harus menggunakan http:// atau https://' };
    }
    
    return { valid: true, message: 'URL valid' };
}

module.exports = {
    detectEmbedType,
    generateEmbedHtml,
    validateEmbedUrl,
    generateYouTubeEmbed,
    generateHlsEmbed,
    generateDashEmbed,
    generateIframeEmbed,
    generateCustomEmbed
};

// Made with Bob
