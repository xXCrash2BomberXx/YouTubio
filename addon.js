#!/usr/bin/env node

const express = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sessions = require('./sessions');
// const util = require('util');

const tmpdir = require('os').tmpdir();
const ytDlpWrap = new YTDlpWrap();
const PORT = process.env.PORT || 7000;
const prefix = 'yt_id:';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ? Buffer.from(process.env.ENCRYPTION_KEY, 'base64') : crypto.randomBytes(32);
const ALGORITHM = 'aes-256-gcm';

const extractors = ytDlpWrap.getExtractors();
const supportedWebsites = new Promise(async resolve => {
    return resolve(`<ul style="list-style-type: none;">${(await extractors).map(extractor => '<li>'+extractor+'</li>').join('')}</ul>`);
});

function encrypt(text) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
        ALGORITHM,
        crypto.createHash('sha256').update(Buffer.concat([ENCRYPTION_KEY, salt])).digest(),
        iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedData) {
    const parts = encryptedData.split(':');
    if (parts.length !== 4) throw new Error('Invalid encrypted data format');
    const salt = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = parts[3];
    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        crypto.createHash('sha256').update(Buffer.concat([ENCRYPTION_KEY, salt])).digest(),
        iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

let counter = 0;
async function runYtDlpWithAuth(configParam, argsArray) {
    try {
        console.log(`[YT-DLP] Received configParam: ${configParam} (length: ${configParam.length})`);
        
        const config = await decryptConfig(configParam);
        console.log(`[YT-DLP] Decrypted config keys: ${Object.keys(config)}`);
        
        // I cookie sono ora salvati come stringa criptata diretta
        let auth = config.encrypted || null;
        
        console.log(`[YT-DLP] Extracted auth: ${auth ? `${auth.length} characters` : 'null/undefined'}`);
        console.log(`[YT-DLP] Config.encrypted type: ${typeof config.encrypted}`);
        if (config.encrypted && typeof config.encrypted === 'object') {
            console.log(`[YT-DLP] Config.encrypted keys: ${Object.keys(config.encrypted)}`);
        }
        const cookies = auth;
        const filename = cookies ? path.join(tmpdir, `cookies-${Date.now()}-${counter++}.txt`) : '';
        counter %= Number.MAX_SAFE_INTEGER;
        
        if (filename) {
            // Decripta i cookie prima di scriverli nel file
            let decryptedCookies;
            try {
                decryptedCookies = decrypt(cookies);
                console.log(`[YT-DLP] Cookies decrypted successfully`);
            } catch (error) {
                console.error(`[YT-DLP] Failed to decrypt cookies:`, error.message);
                // Se la decrittazione fallisce, prova a usare i cookie così come sono
                decryptedCookies = cookies;
            }
            
            await fs.writeFile(filename, decryptedCookies);
            console.log(`[YT-DLP] Written cookies to: ${filename}`);
        } else {
            console.log(`[YT-DLP] NO COOKIES - filename is empty`);
        }
        
        const fullArgs = [
            ...argsArray,
            '-i',
            '-q',
            '--no-warnings',
            '-s',
            '--no-cache-dir',
            '--flat-playlist',
            '-J',
            '--ies', process.env.YTDLP_EXTRACTORS ?? 'all',
            '--default-search', 'ytsearch100',
            '--extractor-args', 'generic:impersonate',
            ...(cookies ? ['--cookies', filename] : [])
        ];
        
        // Debug logging
        console.log(`[YT-DLP] Command: yt-dlp ${fullArgs.join(' ')}`);
        
        const result = await ytDlpWrap.execPromise(fullArgs);
        const parsed = JSON.parse(result);
        
        // Debug risultato
        if (parsed.entries) {
            console.log(`[YT-DLP] Success: Found ${parsed.entries.length} entries`);
        } else if (parsed.title) {
            console.log(`[YT-DLP] Success: Single video - ${parsed.title}`);
        } else {
            console.log(`[YT-DLP] Success: Raw result`, typeof parsed);
        }
        
        return parsed;
        
    } catch (error) {
        console.error(`[YT-DLP] Error:`, error.message);
        throw error;
    } finally {
        try {
            if (filename) await fs.unlink(filename);
        } catch (error) {}
    }
}

const app = express();
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Test validità cookie
app.post('/test-cookies', async (req, res) => {
    try {
        const { cookies } = req.body;
        if (!cookies || !cookies.trim()) {
            return res.json({ 
                valid: true, 
                message: 'No cookies provided - basic functionality will work',
                details: 'Search and public playlists will work. Personal playlists (Watch Later, Subscriptions, History) will not be available.'
            });
        }

        // Crea file temporaneo per i cookies
        const tempFile = path.join(tmpdir, `cookies-test-${Date.now()}-${Math.random()}.txt`);
        
        // Decripta i cookie se sono criptati
        let decryptedCookies = cookies;
        try {
            decryptedCookies = decrypt(cookies);
        } catch (error) {
            // Se la decrittazione fallisce, usa i cookie così come sono
            // (potrebbero essere già in formato testo)
            console.log(`[TEST-COOKIES] Using cookies as-is (not encrypted or decryption failed)`);
        }
        
        await fs.writeFile(tempFile, decryptedCookies);

        try {
            // Test con gli stessi parametri usati in produzione
            const result = await ytDlpWrap.execPromise([
                ':ytwatchlater',
                '-I', '1:5:1', // Test solo i primi 5 per velocità
                '--cookies', tempFile,
                '-i',
                '-q',
                '--no-warnings',
                '-s',
                '--no-cache-dir',
                '--flat-playlist',
                '-J',
                '--ies', process.env.YTDLP_EXTRACTORS ?? 'all',
                '--default-search', 'ytsearch100',
                '--extractor-args', 'generic:impersonate'
            ]);

            // Se arriviamo qui, i cookie sono validi
            const data = JSON.parse(result);
            const hasEntries = data.entries && data.entries.length > 0;
            
            return res.json({
                valid: true,
                authenticated: true,
                message: hasEntries 
                    ? `Cookies valid! Found ${data.entries.length} items in Watch Later`
                    : 'Cookies valid! Watch Later is empty, but authentication works',
                details: 'All personal playlists (Watch Later, Subscriptions, History, Recommendations) will be available.'
            });

        } catch (error) {
            const errorMessage = error.message || error.toString();
            
            // Analizza il tipo di errore
            if (errorMessage.includes('The playlist does not exist') || 
                errorMessage.includes('This playlist is private') ||
                errorMessage.includes('Sign in to confirm') ||
                errorMessage.includes('Please sign in')) {
                
                return res.json({
                    valid: false,
                    authenticated: false,
                    message: 'Cookies are invalid or expired',
                    details: 'Personal playlists will not work. Please update your cookies. Search and public playlists will still work.',
                    error: 'Authentication failed'
                });
            }

            // Test fallback: prova una ricerca semplice per vedere se i cookie sono almeno parsabili
            try {
                await ytDlpWrap.execPromise([
                    'ytsearch1:test',
                    '--cookies', tempFile,
                    '--flat-playlist',
                    '-J',
                    '-q',
                    '--no-warnings'
                ]);

                return res.json({
                    valid: true,
                    authenticated: false,
                    message: 'Cookies format valid but authentication failed',
                    details: 'Search and public playlists will work. Personal playlists may not work properly.',
                    warning: errorMessage
                });

            } catch (fallbackError) {
                return res.json({
                    valid: false,
                    authenticated: false,
                    message: 'Cookies format is invalid',
                    details: 'Please check your cookies.txt format. Basic functionality will still work.',
                    error: fallbackError.message
                });
            }
        }

    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Cookie test error:', error);
        return res.json({
            valid: false,
            authenticated: false,
            message: 'Failed to test cookies',
            details: 'There was an error testing your cookies. Basic functionality will still work.',
            error: error.message
        });
    } finally {
        // Pulizia del file temporaneo
        try {
            if (tempFile) await fs.unlink(tempFile);
        } catch (error) {}
    }
});

// Config Encryption Endpoint
app.post('/encrypt', (req, res) => {
    try {
        // Se viene inviato un campo 'auth', cripta solo quello (per i cookie)
        // Altrimenti cripta tutto il body (per compatibilità)
        if (req.body.auth) {
            res.send(encrypt(req.body.auth));
        } else {
            res.send(encrypt(JSON.stringify(req.body)));
        }
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Encryption error:', error);
        res.status(500).send('Encryption failed');
    }
});

// Crea nuova sessione
app.post('/session', async (req, res) => {
    try {
        const { config, password } = req.body;
        if (!config || !password) {
            return res.status(400).json({ error: 'Config and password are required' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }
        
        const sessionId = await sessions.createSession(config, password);
        console.log(`[SESSIONS] New session created: ${sessionId}`);
        res.json({ sessionId });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Session creation error:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// Aggiorna sessione esistente
app.put('/session/:id', async (req, res) => {
    try {
        const { config, password } = req.body;
        if (!config || !password) {
            return res.status(400).json({ error: 'Config and password are required' });
        }
        
        const success = await sessions.updateSession(req.params.id, password, config);
        if (success) {
            console.log(`[SESSIONS] Session updated: ${req.params.id}`);
            res.json({ success: true });
        } else {
            console.log(`[SESSIONS] Failed to update session (invalid credentials): ${req.params.id}`);
            res.status(401).json({ error: 'Invalid session ID or password' });
        }
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Session update error:', error);
        res.status(500).json({ error: 'Failed to update session' });
    }
});

// Elimina sessione
app.delete('/session/:id', async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }
        
        const success = await sessions.deleteSession(req.params.id, password);
        if (success) {
            console.log(`[SESSIONS] Session deleted: ${req.params.id}`);
            res.json({ success: true });
        } else {
            console.log(`[SESSIONS] Failed to delete session (invalid credentials): ${req.params.id}`);
            res.status(401).json({ error: 'Invalid session ID or password' });
        }
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Session deletion error:', error);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

// Ottieni configurazione sessione con password
app.post('/session/:id/config', async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }
        
        const sessionData = await sessions.getSession(req.params.id, password);
        if (sessionData) {
            if (sessionData.expired) {
                return res.status(410).json({ error: 'Session expired', sessionId: sessionData.sessionId });
            }
            res.json({
                id: sessionData.id,
                config: sessionData.config,
                createdAt: sessionData.createdAt,
                lastAccessed: sessionData.lastAccessed,
                expiresAt: sessionData.expiresAt
            });
        } else {
            res.status(401).json({ error: 'Invalid session ID or password' });
        }
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Session config error:', error);
        res.status(500).json({ error: 'Failed to get session config' });
    }
});

// Ottieni informazioni sessione (senza password)
app.get('/session/:id/info', async (req, res) => {
    try {
        const sessionData = await sessions.getSession(req.params.id);
        if (sessionData) {
            if (sessionData.expired) {
                return res.status(410).json({ error: 'Session expired', sessionId: sessionData.sessionId });
            }
            res.json({
                id: sessionData.id,
                createdAt: sessionData.createdAt,
                lastAccessed: sessionData.lastAccessed,
                expiresAt: sessionData.expiresAt
            });
        } else {
            res.status(404).json({ error: 'Session not found' });
        }
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Session info error:', error);
        res.status(500).json({ error: 'Failed to get session info' });
    }
});

// Config Decryption - Aggiornata per supportare sessioni
async function decryptConfig(configParam, enableDecryption = true) {
    // Se è un session ID, recupera la configurazione dalla sessione
    if (sessions.isValidSessionId(configParam)) {
        const sessionData = await sessions.getSession(configParam);
        if (sessionData) {
            if (sessionData.expired) {
                console.log(`[SESSIONS] Attempted to use expired session: ${configParam}`);
                return {};
            }
            return sessionData.config;
        }
        // Se la sessione non esiste, ritorna configurazione vuota
        console.log(`[SESSIONS] Session not found: ${configParam}`);
        return {};
    }
    
    // Altrimenti usa il vecchio metodo di decrittazione
    try {
        const config = JSON.parse(configParam);
        if (enableDecryption && config.encrypted) {
            try {
                config.encrypted = JSON.parse(decrypt(config.encrypted));
            } catch (error) {
                if (process.env.DEV_LOGGING) console.error('Decryption error:', error);
                config.encrypted = undefined;
            }
        }
        return config;
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Config parsing error:', error);
        return {};
    }
}

// Stremio Addon Manifest Route
app.get('/:config/manifest.json', async (req, res) => {
    try {
        const userConfig = await decryptConfig(req.params.config, false);
        return res.json({
            id: 'youtubio.elfhosted.com',
            version: '0.4.4',
            name: 'YouTubio | ElfHosted',
            description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
            resources: ['catalog', 'stream', 'meta'],
            types: ['movie', 'channel'],
            idPrefixes: [prefix],
            catalogs: (userConfig.catalogs?.map(c => ({
                ...c,
                extra: [ { name: 'skip', isRequired: false } ]
            })) ?? [
                { type: 'YouTube', id: `${prefix}:ytrec`, name: 'Discover', extra: [ { name: 'skip', isRequired: false } ] },
                { type: 'YouTube', id: `${prefix}:ytsubs`, name: 'Subscriptions', extra: [ { name: 'skip', isRequired: false } ] },
                { type: 'YouTube', id: `${prefix}:ytwatchlater`, name: 'Watch Later', extra: [ { name: 'skip', isRequired: false } ] },
                { type: 'YouTube', id: `${prefix}:ythistory`, name: 'History', extra: [ { name: 'skip', isRequired: false } ] }
            ]).concat([
                // Add search unless explicitly disabled
                ...(userConfig.search === false ? [] : [
                    { type: 'YouTube', id: `${prefix}:ytsearch100`, name: 'Mixed', extra: [ { name: 'search', isRequired: true }, { name: 'skip', isRequired: false } ] },
                    { type: 'YouTube', id: `${prefix}:ytsearch100:video`, name: 'Video', extra: [ { name: 'search', isRequired: true }, { name: 'skip', isRequired: false } ] },
                    { type: 'YouTube', id: `${prefix}:ytsearch100:channel`, name: 'Channel', extra: [ { name: 'search', isRequired: true }, { name: 'skip', isRequired: false } ] }
                ])
            ]),
            logo: 'https://github.com/xXCrash2BomberXx/YouTubio/blob/main/YouTubio.png?raw=true',
            behaviorHints: {
                configurable: true
            },
            "stremioAddonsConfig": {
                "issuer": "https://stremio-addons.net",
                "signature": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..tLliZZqbqp8DSpNFCa_o7g.1Zu-sGRA8Xmc-qG9d_ctvcvrbtBFdVH8Kqmj9RL-ONB5C5iiy5qITOH3Z1nrTfQuiIhwJyQuU0npD0S8lYtv5InjpulZHYQDdBJpPnTvn1jqwM4AgDPCpm05lNLYW3Kp.IpryYoO1JqXwFBmkHrD3OA"
            }
        });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Manifest handler: ' + error);
        return res.json({});
    }
});

// Stremio Addon Catalog Route
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Catalog handler: "${req.params.id}"`);
        const userConfig = await decryptConfig(req.params.config, false);
        const catalogConfig = userConfig.catalogs?.find(cat => cat.id === req.params.id);
        let videoId = req.params.id?.slice(prefix.length);
        const query = Object.fromEntries(new URLSearchParams(req.params.extra ?? ''));
        const skip = parseInt(query?.skip ?? 0);
        const videoIdCopy = videoId;
        switch (catalogConfig?.channelType) {
        case 'video':
            // Saved Video Search
            videoId = `https://www.youtube.com/results?sp=EgIQAQ%253D%253D&search_query=${encodeURIComponent(videoId)}`;
            break;
        case 'channel':
            // Saved Channel Search
            videoId = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(videoId)}`;
            break;
        case 'auto':
        case undefined:
        default:
            switch (videoIdCopy) {
            // YT-DLP Playlists
            case ':ytfav':
            case ':ytwatchlater':
            case ':ytsubs':
            case ':ythistory':
            case ':ytrec':
            case ':ytnotif':
                break;
            default:
                // YT-DLP Search
                if (videoIdCopy.startsWith(':ytsearch100')) {
                    if (!query?.search) throw new Error("Missing query parameter");
                    switch(videoIdCopy.slice(':ytsearch100'.length)) {
                    // Video Search
                    case ':video':
                        videoId = `https://www.youtube.com/results?sp=EgIQAQ%253D%253D&search_query=${encodeURIComponent(query.search)}`;
                        break;
                    // Channel Search
                    case ':channel':
                        videoId = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(query.search)}`;
                        break;
                    // Mixed Search
                    case '':
                    default:
                        videoId = query.search;
                        break;
                    // Channels
                    }
                } else if ( (videoId = videoIdCopy.match(/^@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]$/)) ) {
                    videoId = `https://www.youtube.com/${videoId[0]}/videos`;
                // Playlists
                } else if ( (videoId = videoIdCopy.match(/^PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})$/)) ) {
                    videoId = `https://www.youtube.com/playlist?list=${videoId[0]}`;
                // Saved YT-DLP Search
                } else {
                    videoId = videoIdCopy;
                }
                break;
            }
            break;
        }
        const videos = await runYtDlpWithAuth(req.params.config, [
            videoId,
            '-I', `${skip + 1}:${skip + 100}:1`,
        ]);
        return res.json({
            metas: (videos.entries ?? [ videos ]).map(video => {
                    const channel = video.ie_key === 'YoutubeTab';
                    return (channel ? video.uploader_id : (video.id ?? video.url)) ? {
                        id: prefix + (channel ? video.uploader_id : (video.id ?? video.url)),
                        type: channel ? 'channel' : 'movie',
                        name: video.title ?? 'Unknown Title',
                        poster: ((channel ? 'https:' : '') + (video.thumbnail ?? video.thumbnails?.at(-1)?.url ?? '')) ?? undefined,
                        posterShape: channel ? 'square' : 'landscape',
                        description: video.description ?? video.title,
                        releaseInfo: video.upload_date?.substring(0, 4)
                    } : null;
                }).filter(meta => meta !== null),
            behaviorHints: { cacheMaxAge: 0 }
        });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Catalog handler: ' + error);
        return res.json({ metas: [] });
    }
});

// Stremio Addon Meta Route
app.get('/:config/meta/:type/:id.json', async (req, res) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Meta handler: "${req.params.id}"`);
        const userConfig = await decryptConfig(req.params.config, false);
        const videoId = req.params.id?.slice(prefix.length);
        const ref = req.get('Referrer');
        const protocol = ref ? ref + '#' : 'stremio://';
        const manifestUrl = encodeURIComponent(`${req.protocol}://${req.get('host')}/${encodeURIComponent(req.params.config)}/manifest.json`);
        let command;
        if ( (command = videoId.match(/^@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]$/)) ) {
            command = `https://www.youtube.com/${command[0]}/videos`;
        // Playlists
        } else if ( (command = videoId.match(/^PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})$/)) ) {
            command = `https://www.youtube.com/watch?v=${command[0]}`;
        } else {
            command = videoId;
        }
        const video = await runYtDlpWithAuth(req.params.config, [
            command,
            '--playlist-end', '1',  // Only fetch the first video since this never needs more than one
            '--ignore-no-formats-error',
            ...(userConfig.markWatchedOnLoad ? ['--mark-watched'] : [])
        ]);
        
        // Debug logging per capire cosa contiene il video
        console.log(`[META] Video object keys: ${Object.keys(video)}`);
        console.log(`[META] Video uploader_id: ${video.uploader_id}`);
        console.log(`[META] Video uploader: ${video.uploader}`);
        console.log(`[META] Video _type: ${video._type}`);
        
        const channel = video._type === 'playlist';
        const title = video.title ?? 'Unknown Title';
        const thumbnail = video.thumbnail ?? video.thumbnails?.at(-1).url;
        const released = new Date(video.release_timestamp ? video.release_timestamp * 1000 : video.upload_date ? `${video.upload_date.substring(0, 4)}-${video.upload_date.substring(4, 6)}-${video.upload_date.substring(6, 8)}T00:00:00Z` : 0).toISOString();
        const subtitles = Object.entries(video.subtitles ?? {}).map(([k, v]) => {
            const srt = v.find?.(x => x.ext == 'srt') ?? v[0];
            return srt ? {
                id: srt.name,
                url: srt.url,
                lang: k
            } : null;
        }).concat(
            Object.entries(video.automatic_captions ?? {}).map(([k, v]) => {
                const srt = v.find?.(x => x.ext == 'srt') ?? v[0];
                return srt ? {
                    id: `Auto ${srt.name}`,
                    url: srt.url,
                    lang: k
                } : null;
            })
        ).filter(srt => srt !== null);
        return res.json({ meta: {
            id: req.params.id,
            type: req.params.type,
            name: title,
            genres: video.tags,
            poster: thumbnail,
            posterShape: channel ? 'square' : 'landscape',
            background: thumbnail,
            logo: thumbnail,
            description: video.description ?? title,
            releaseInfo: parseInt(video.release_year ?? video.upload_date?.substring(0, 4)),
            released: released,
            videos: [{
                id: req.params.id + ':1:1',
                title: title,
                released: released,
                thumbnail: thumbnail,
                streams: [
                    ...(!channel ? [
                        ...(video.formats ?? [video]).filter(src => userConfig.showBrokenLinks || (!src.format_id.startsWith('sb') && src.acodec !== 'none' && src.vcodec !== 'none')).toReversed().map(src => ({
                            name: `YT-DLP Player ${src.resolution}`,
                            url: src.url,
                            description: src.format,
                            subtitles: subtitles,
                            behaviorHints: {
                                ...(src.protocol !== 'https' || src.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                                videoSize: src.filesize_approx,
                                filename: video.filename
                            }
                        })), ...(videoId.match(/^[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048]$/) ? [{
                            name: 'Stremio Player',
                            ytId: videoId,
                            description: 'Click to watch using Stremio\'s built-in YouTube Player'
                        }] : []), {
                            name: 'External Player',
                            externalUrl: video.webpage_url,
                            description: 'Click to watch in the External Player'
                        }
                    ] : []), ...(video.uploader_id ? (() => {
                        console.log(`[META] Creating channel link for uploader_id: ${video.uploader_id}`);
                        console.log(`[META] Channel URL: ${protocol}/discover/${manifestUrl}/movie/${encodeURIComponent(prefix + video.uploader_id)}`);
                        return [{
                            name: 'YT-DLP Channel',
                            externalUrl: `${protocol}/discover/${manifestUrl}/catalog/YouTube/${encodeURIComponent(prefix + video.uploader_id)}`,
                            description: 'Click to open the channel as a Catalog'
                        }];
                    })() : []), ...(video.uploader_url ? [{
                        name: 'External Channel',
                        externalUrl: video.uploader_url,
                        description: 'Click to open the channel in the External Player'
                    }] : [])
                ],
                episode: 1,
                season: 1,
                overview: video.description ?? title
            }],
            runtime: `${Math.floor((video.duration ?? 0) / 60)} min`,
            language: video.language,
            website: video.webpage_url,
            behaviorHints: { defaultVideoId: req.params.id + ':1:1' }
        } });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Meta handler: ' + error);
        return res.json({ meta: {} });
    }
});

// Stremio Addon Stream Route
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    try {
        if (!req.params.id?.startsWith(prefix)) {
            return res.json({ streams: [] });
        }
        
        const userConfig = await decryptConfig(req.params.config, false);
        const videoId = req.params.id?.slice(prefix.length);
        
        // Definisci protocol e manifestUrl per i link ai canali
        const ref = req.query.ref;
        const protocol = ref ? ref + '#' : 'stremio://';
        const manifestUrl = encodeURIComponent(`${req.protocol}://${req.get('host')}/${encodeURIComponent(req.params.config)}/manifest.json`);
        
        // Estrai l'ID del video se è nel formato video:episode:season
        const videoMatch = videoId.match(/^(.+):(\d+):(\d+)$/);
        const actualVideoId = videoMatch ? videoMatch[1] : videoId;
        
        let command;
        if ( (command = actualVideoId.match(/^@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]$/)) ) {
            command = `https://www.youtube.com/${command[0]}/videos`;
        } else if ( (command = actualVideoId.match(/^PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})$/)) ) {
            command = `https://www.youtube.com/watch?v=${actualVideoId}`;
        } else {
            command = actualVideoId;
        }
        
        const video = await runYtDlpWithAuth(req.params.config, [
            command,
            '--ignore-no-formats-error',
            ...(userConfig.markWatchedOnLoad ? ['--mark-watched'] : [])
        ]);
        
        // Filtra i formati in base alle impostazioni
        const streams = (video.formats ?? [video])
            .filter(src => userConfig.showBrokenLinks || (!src.format_id.startsWith('sb') && src.acodec !== 'none' && src.vcodec !== 'none'))
            .toReversed()
            .map(src => ({
                name: `YT-DLP Player ${src.resolution}`,
                url: src.url,
                description: src.format,
                behaviorHints: {
                    ...(src.protocol !== 'https' || src.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                    videoSize: src.filesize_approx,
                    filename: video.filename
                }
            }));
        
        // Aggiungi altri tipi di stream se disponibili
        if (actualVideoId.match(/^[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048]$/)) {
            streams.push({
                name: 'Stremio Player',
                ytId: actualVideoId,
                description: 'Click to watch using Stremio\'s built-in YouTube Player'
            });
        }
        
        streams.push({
            name: 'External Player',
            externalUrl: video.webpage_url,
            description: 'Click to watch in the External Player'
        });
        
        // Aggiungi il link al canale se disponibile
        if (video.uploader_id) {
            streams.push({
                name: 'YT-DLP Channel',
                externalUrl: `${protocol}/discover/${manifestUrl}/catalog/YouTube/${encodeURIComponent(prefix + video.uploader_id)}`,
                description: 'Click to open the channel as a Catalog'
            });
        }
        
        return res.json({ streams });
        
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Stream handler:', error);
        return res.json({ streams: [] });
    }
});

// Configuration Page
app.get(['/', '/:config?/configure'], async (req, res) => {
    let userConfig = {};
    let sessionId = null;
    let isSessionConfig = false;
    
    try {
        if (req.params.config) {
            // Controlla se è un session ID
            if (sessions.isValidSessionId(req.params.config)) {
                sessionId = req.params.config;
                isSessionConfig = true;
                console.log(`[SESSIONS] Configure page accessed with session ID: ${sessionId}`);
                // Non carichiamo la configurazione qui, sarà caricata dal frontend con password
            } else {
                // Vecchio sistema di configurazione
                userConfig = await decryptConfig(req.params.config, false);
            }
        }
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Config handler: ' + error);
        userConfig = {};
    }
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>YouTubio | ElfHosted</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 40px; background: #f4f4f8; color: #333; }
                .container { max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                h1 { color: #d92323; }
                p { font-size: 1.1em; line-height: 1.6; }
                textarea { width: 100%; height: 150px; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; resize: vertical; }
                #playlist-table th, #playlist-table td { border: 1px solid #ccc; padding: 5px; text-align: left; }
                #playlist-table input { width: 100%; box-sizing: border-box; }
                .install-button { display: inline-block; margin-top: 20px; padding: 15px 30px; background-color: #5835b0; color: white; text-decoration: none; font-size: 1.2em; border-radius: 5px; transition: background-color 0.3s; border: none; cursor: pointer; }
                .install-button:hover { background-color: #4a2c93; }
                .install-button:disabled { background-color: #ccc; cursor: not-allowed; }
                .action-button { padding: 5px 10px; font-size: 0.9em; }
                .url-input { width: 100%; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; }
                .instructions { text-align: left; margin-top: 25px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f9; }
                .instructions summary { font-weight: bold; cursor: pointer; }
                .instructions ul { padding-left: 20px; }
                .instructions li { margin-bottom: 8px; }
                #results { margin-top: 20px; }
                .error { color: #d92323; margin-top: 10px; }
                .success { color: #28a745; margin-top: 10px; }
                .info { color: #007bff; margin-top: 10px; }
                .loading { color: #666; font-style: italic; }
                .settings-section { text-align: left; margin-top: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f9; }
                .toggle-container { display: flex; align-items: center; margin: 10px 0; }
                .toggle-container input[type="checkbox"] { margin-right: 10px; }
                .toggle-container label { font-weight: normal; cursor: pointer; }
                .setting-description { font-size: 0.9em; color: #666; margin-top: 5px; line-height: 1.4; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>YouTubio | ElfHosted</h1>
                ${process.env.EMBED || ""}
                For a quick setup guide, go to <a href="https://github.com/xXCrash2BomberXx/YouTubio/tree/main?tab=readme-ov-file#quick-setup-with-cookies" target="_blank" rel="noopener noreferrer">github.com/xXCrash2BomberXx/YouTubio</a>
                <form id="config-form">
                    <div class="settings-section" style="text-align: center;">
                        <details>
                            <summary>
                                This addon supports FAR more than just YouTube with links!<br>
                                <a href="https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md" target="_blank" rel="noopener noreferrer">Read more here.</a>
                            </summary>
                            ${process.env.YTDLP_EXTRACTORS_EMBED || ""}
                            <div style="max-height: 20em; overflow: auto;">
                                ${await supportedWebsites}
                            </div>
                        </details>
                    </div>
                    
                    <div class="settings-section">
                        <h3>Session Management</h3>
                        <div style="margin-bottom: 15px;">
                            <label for="session-password"><strong>Session Password:</strong></label>
                            <input type="password" id="session-password" placeholder="Enter password (min 8 characters)" class="url-input" minlength="8" required>
                            <div class="setting-description">This password will be required to modify your configuration in the future.</div>
                        </div>
                        
                        <div style="margin-bottom: 15px;">
                            <label for="existing-session"><strong>Load Existing Session (optional):</strong></label>
                            <input type="text" id="existing-session" placeholder="Enter existing session ID to modify" class="url-input">
                            <button type="button" id="load-session" class="install-button action-button">Load Session</button>
                            <div class="setting-description">If you have an existing session ID, enter it here to load and modify your configuration.</div>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3>Cookies</h3>
                        <textarea id="cookie-data" placeholder="Paste the content of your cookies.txt file here..."></textarea>
                        <div style="margin-top: 10px;">
                            <button type="button" class="install-button action-button" id="clear-cookies">Clear</button>
                            <button type="button" class="install-button action-button" id="test-cookies">Test Cookies</button>
                        </div>
                        <div id="cookie-test-result" style="display: none; margin-top: 10px; padding: 10px; border-radius: 5px;"></div>
                    </div>
                    <div class="settings-section">
                        <h3>Playlists</h3>
                        <div style="margin-bottom: 10px;">
                            <button type="button" id="add-defaults" class="install-button action-button">Add Defaults</button>
                            <button type="button" id="remove-defaults" class="install-button action-button">Remove Defaults</button>
                            <button type="button" id="add-playlist" class="install-button action-button">Add Playlist</button>
                        </div>
                        <table id="playlist-table" style="width:100%;border-collapse:collapse;">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Playlist ID / URL</th>
                                    <th>Name</th>
                                    <th>Search Type</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                    <div class="settings-section" id="addon-settings">
                        <h3>Settings</h3>
                        <table>
                            <thead>
                                <tr>
                                    <th>Value</th>
                                    <th>Setting</th>
                                    <th>Description</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td><input type="checkbox" id="markWatchedOnLoad" name="markWatchedOnLoad"></td>
                                    <td><label for="markWatchedOnLoad">Mark watched on load</label></td>
                                    <td class="setting-description">When enabled, videos will be automatically marked as watched in your YouTube history when you open them in Stremio. This helps keep your YouTube watch history synchronized.</td>
                                </tr>
                                <tr>
                                    <td><input type="checkbox" id="search" name="search" checked></td>
                                    <td><label for="search">Allow searching</label></td>
                                    <td class="setting-description">When enabled, Stremio's search feature will also return YouTube results.</td>
                                </tr>
                                <tr>
                                    <td><input type="checkbox" id="showBrokenLinks" name="showBrokenLinks"></td>
                                    <td><label for="showBrokenLinks">Show Broken Links</label></td>
                                    <td class="setting-description">When enabled, all resolutions found by YT-DLP will be returned, not just ones supported by Stremio. This may fix some issues if you encounter crashes on vidoes without it enabled.</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <button type="submit" class="install-button" id="submit-btn">Create Session</button>
                    <div id="error-message" class="error" style="display:none;"></div>
                </form>
                <div id="results" style="display:none;">
                    <h2>Install your addon</h2>
                    <a href="#" target="_blank" id="install-stremio" class="install-button">Stremio</a>
                    <a href="#" target="_blank" id="install-web" class="install-button">Stremio Web</a>
                    <a id="copy-btn" class="install-button">Copy URL</a>
                    <input type="text" id="install-url" style="display: none;" readonly class="url-input">
                </div>
            </div>
            <script>
                const cookies = document.getElementById('cookie-data');
                const addonSettings = document.getElementById('addon-settings');
                const submitBtn = document.getElementById('submit-btn');
                const errorDiv = document.getElementById('error-message');
                const installStremio = document.getElementById('install-stremio');
                const installUrlInput = document.getElementById('install-url');
                const installWeb = document.getElementById('install-web');
                const playlistTableBody = document.querySelector('#playlist-table tbody');
                const sessionPasswordInput = document.getElementById('session-password');
                const existingSessionInput = document.getElementById('existing-session');
                const loadSessionBtn = document.getElementById('load-session');
                const testCookiesBtn = document.getElementById('test-cookies');
                const cookieTestResult = document.getElementById('cookie-test-result');
                
                let currentSessionId = null;
                let isUpdatingSession = false;
                
                const defaultPlaylists = [
                    { type: 'YouTube', id: ':ytrec', name: 'Discover', channelType: 'auto' },
                    { type: 'YouTube', id: ':ytsubs', name: 'Subscriptions', channelType: 'auto' },
                    { type: 'YouTube', id: ':ytwatchlater', name: 'Watch Later', channelType: 'auto' },
                    { type: 'YouTube', id: ':ythistory', name: 'History', channelType: 'auto' }
                ];
                
                let playlists = ${userConfig.catalogs ? JSON.stringify(userConfig.catalogs.map(pl => ({
                    ...pl,
                    id: pl.id.startsWith(prefix) ? pl.id.slice(prefix.length) : pl.id
                }))) : 'JSON.parse(JSON.stringify(defaultPlaylists))'};

                // Gestione session ID dal URL
                ${isSessionConfig ? `
                const preloadedSessionId = '${sessionId}';
                existingSessionInput.value = preloadedSessionId;
                currentSessionId = preloadedSessionId;
                
                // Mostra che stiamo caricando una sessione esistente
                showInfo('Please enter your password to load the session configuration.');
                sessionPasswordInput.focus();
                ` : `
                // Controlla se stiamo caricando una sessione esistente tramite query parameter
                const urlParams = new URLSearchParams(window.location.search);
                const urlSessionId = urlParams.get('session');
                if (urlSessionId) {
                    existingSessionInput.value = urlSessionId;
                    loadSession();
                }
                `}

                // Inizializza i campi con i dati dell'utente
                ${userConfig.encrypted ? `cookies.value = ${JSON.stringify(userConfig.encrypted)}; cookies.disabled = true;` : ''}
                document.getElementById('markWatchedOnLoad').checked = ${userConfig.markWatchedOnLoad === true ? 'true' : 'false'};
                document.getElementById('search').checked = ${userConfig.search === false ? 'false' : 'true'};
                document.getElementById('showBrokenLinks').checked = ${userConfig.showBrokenLinks === true ? 'true' : 'false'};

                // Carica sessione esistente
                loadSessionBtn.addEventListener('click', loadSession);
                
                async function loadSession() {
                    const sessionId = existingSessionInput.value.trim();
                    const password = sessionPasswordInput.value.trim();
                    
                    if (!sessionId) {
                        showError('Please enter a session ID');
                        return;
                    }
                    
                    if (!password) {
                        showError('Please enter your password to load the session');
                        return;
                    }
                    
                    try {
                        loadSessionBtn.disabled = true;
                        loadSessionBtn.textContent = 'Loading...';
                        
                        // Carica la configurazione con password
                        const configResponse = await fetch(\`/session/\${sessionId}/config\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: password })
                        });
                        
                        if (!configResponse.ok) {
                            const errorData = await configResponse.json();
                            if (configResponse.status === 410) {
                                throw new Error('Session expired');
                            }
                            if (configResponse.status === 401) {
                                throw new Error('Invalid password');
                            }
                            throw new Error(errorData.error || 'Failed to load session');
                        }
                        
                        const sessionData = await configResponse.json();
                        
                        // Popola i campi con i dati della sessione
                        if (sessionData.config.encrypted) {
                            cookies.value = sessionData.config.encrypted;
                            cookies.disabled = true;
                        }
                        
                        if (sessionData.config.catalogs) {
                            playlists = sessionData.config.catalogs.map(pl => ({
                                ...pl,
                                id: pl.id.startsWith('${prefix}') ? pl.id.slice('${prefix}'.length) : pl.id
                            }));
                            renderPlaylists();
                        }
                        
                        // Imposta le altre opzioni
                        document.getElementById('markWatchedOnLoad').checked = sessionData.config.markWatchedOnLoad === true;
                        document.getElementById('search').checked = sessionData.config.search !== false;
                        document.getElementById('showBrokenLinks').checked = sessionData.config.showBrokenLinks === true;
                        
                        currentSessionId = sessionId;
                        isUpdatingSession = true;
                        submitBtn.textContent = 'Update Session';
                        showSuccess(\`Session loaded successfully. Created: \${new Date(sessionData.createdAt).toLocaleString()}\`);
                        
                        // Genera i link di installazione immediati
                        const manifestUrl = \`\${window.location.protocol}//\${window.location.host}/\${sessionId}/manifest.json\`;
                        installStremio.href = \`stremio://\${window.location.host}/\${sessionId}/manifest.json\`;
                        installUrlInput.value = manifestUrl;
                        installWeb.href = \`https://web.stremio.com/#/addons?addon=\${encodeURIComponent(manifestUrl)}\`;
                        document.getElementById('results').style.display = 'block';
                        
                    } catch (error) {
                        showError(\`Failed to load session: \${error.message}\`);
                        currentSessionId = null;
                        isUpdatingSession = false;
                    } finally {
                        loadSessionBtn.disabled = false;
                        loadSessionBtn.textContent = 'Load Session';
                    }
                }

                // Funzioni per mostrare messaggi
                function showError(message) {
                    errorDiv.textContent = message;
                    errorDiv.style.display = 'block';
                    errorDiv.className = 'error';
                }
                
                function showSuccess(message) {
                    errorDiv.textContent = message;
                    errorDiv.style.display = 'block';
                    errorDiv.className = 'success';
                }
                
                function showInfo(message) {
                    errorDiv.textContent = message;
                    errorDiv.style.display = 'block';
                    errorDiv.className = 'info';
                }

                function showWarning(message) {
                    errorDiv.textContent = message;
                    errorDiv.style.display = 'block';
                    errorDiv.className = 'warning';
                }

                document.getElementById('clear-cookies').addEventListener('click', () => {
                    cookies.value = "";
                    cookies.disabled = false;
                    // Nascondi risultato test precedente
                    cookieTestResult.style.display = 'none';
                });

                // Test cookies functionality
                testCookiesBtn.addEventListener('click', testCookies);

                async function testCookies() {
                    const cookieData = cookies.value.trim();
                    
                    try {
                        testCookiesBtn.disabled = true;
                        testCookiesBtn.textContent = 'Testing...';
                        cookieTestResult.style.display = 'none';

                        const response = await fetch('/test-cookies', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ cookies: cookieData })
                        });

                        if (!response.ok) {
                            throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
                        }

                        const result = await response.json();
                        displayCookieTestResult(result);

                    } catch (error) {
                        displayCookieTestResult({
                            valid: false,
                            authenticated: false,
                            message: 'Test failed',
                            details: \`Error testing cookies: \${error.message}\`,
                            error: error.message
                        });
                    } finally {
                        testCookiesBtn.disabled = false;
                        testCookiesBtn.textContent = 'Test Cookies';
                    }
                }

                function displayCookieTestResult(result) {
                    cookieTestResult.style.display = 'block';
                    
                    let className = 'cookie-result ';
                    if (result.valid && result.authenticated) {
                        className += 'success';
                    } else if (result.valid && !result.authenticated) {
                        className += 'warning';
                    } else {
                        className += 'error';
                    }
                    
                    cookieTestResult.className = className;
                    cookieTestResult.innerHTML = \`
                        <div class="cookie-result-title">\${result.message}</div>
                        <div class="cookie-result-details">\${result.details}</div>
                        \${result.error ? \`<div class="cookie-result-details" style="margin-top: 5px;"><strong>Error:</strong> \${result.error}</div>\` : ''}
                        \${result.warning ? \`<div class="cookie-result-details" style="margin-top: 5px;"><strong>Warning:</strong> \${result.warning}</div>\` : ''}
                    \`;
                }

                function renderPlaylists() {
                    playlistTableBody.innerHTML = '';
                    playlists.forEach((pl, index) => {
                        const row = document.createElement('tr');
                        // Type
                        const typeCell = document.createElement('td');
                        const typeInput = document.createElement('input');
                        typeInput.value = pl.type;
                        typeInput.addEventListener('input', () => pl.type = typeInput.value.trim());
                        typeCell.appendChild(typeInput);
                        // ID
                        const idCell = document.createElement('td');
                        const idInput = document.createElement('input');
                        idInput.value = pl.id;
                        idInput.addEventListener('change', () => pl.id = idInput.value);
                        idCell.appendChild(idInput);
                        // Name
                        const nameCell = document.createElement('td');
                        const nameInput = document.createElement('input');
                        nameInput.value = pl.name;
                        nameInput.addEventListener('input', () => pl.name = nameInput.value.trim());
                        nameCell.appendChild(nameInput);
                        // Channel Search
                        const channelTypeCell = document.createElement('td');
                        const channelTypeInput = document.createElement('select');
                        const optAuto = document.createElement('option');
                        optAuto.value = 'auto';
                        optAuto.textContent = 'Auto';
                        channelTypeInput.appendChild(optAuto);
                        const optVideo = document.createElement('option');
                        optVideo.value = 'video';
                        optVideo.textContent = 'Video';
                        channelTypeInput.appendChild(optVideo);
                        const optChannel = document.createElement('option');
                        optChannel.value = 'channel';
                        optChannel.textContent = 'Channel';
                        channelTypeInput.appendChild(optChannel);
                        channelTypeInput.value = pl.channelType;
                        channelTypeInput.addEventListener('change', () => pl.channelType = channelTypeInput.value);
                        channelTypeCell.appendChild(channelTypeInput);
                        // Actions
                        const actionsCell = document.createElement('td');
                        const upBtn = document.createElement('button');
                        upBtn.textContent = '↑';
                        upBtn.addEventListener('click', () => {
                            if (index > 0) {
                                [playlists[index - 1], playlists[index]] = [playlists[index], playlists[index - 1]];
                                renderPlaylists();
                            }
                        });
                        const downBtn = document.createElement('button');
                        downBtn.textContent = '↓';
                        downBtn.addEventListener('click', () => {
                            if (index < playlists.length - 1) {
                                [playlists[index + 1], playlists[index]] = [playlists[index], playlists[index + 1]];
                                renderPlaylists();
                            }
                        });
                        const removeBtn = document.createElement('button');
                        removeBtn.textContent = 'Remove';
                        removeBtn.addEventListener('click', () => {
                            playlists.splice(index, 1);
                            renderPlaylists();
                        });
                        actionsCell.appendChild(upBtn);
                        actionsCell.appendChild(downBtn);
                        actionsCell.appendChild(removeBtn);
                        row.appendChild(typeCell);
                        row.appendChild(idCell);
                        row.appendChild(nameCell);
                        row.appendChild(channelTypeCell);
                        row.appendChild(actionsCell);
                        playlistTableBody.appendChild(row);
                    });
                }

                document.getElementById('add-playlist').addEventListener('click', () => {
                    playlists.push({ type: 'YouTube', id: '', name: '', channelType: 'auto' });
                    renderPlaylists();
                });

                document.getElementById('add-defaults').addEventListener('click', () => {
                    playlists = [...playlists, ...defaultPlaylists];
                    renderPlaylists();
                });

                document.getElementById('remove-defaults').addEventListener('click', () => {
                    playlists = playlists.filter(pl => !defaultPlaylists.some(def => def.id === pl.id));
                    renderPlaylists();
                });

                renderPlaylists();

                // Submit form - ora gestisce sia creazione che aggiornamento sessioni
                document.getElementById('config-form').addEventListener('submit', async function(event) {
                    event.preventDefault();
                    
                    const password = sessionPasswordInput.value.trim();
                    if (!password || password.length < 8) {
                        showError('Password must be at least 8 characters long');
                        return;
                    }
                    
                    submitBtn.disabled = true;
                    errorDiv.style.display = 'none';
                    
                    try {
                        // Se abbiamo un session ID precaricato ma non abbiamo ancora caricato la configurazione
                        if (currentSessionId && !isUpdatingSession) {
                            await loadSessionWithPassword(currentSessionId, password);
                            return;
                        }

                        // Test automatico dei cookie se forniti (solo per nuove sessioni o aggiornamenti significativi)
                        if (cookies.value.trim() && !cookies.disabled) {
                            submitBtn.textContent = 'Testing Cookies...';
                            const cookieTestResult = await fetch('/test-cookies', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ cookies: cookies.value.trim() })
                            });

                            if (cookieTestResult.ok) {
                                const testResult = await cookieTestResult.json();
                                
                                // Mostra risultato del test
                                displayCookieTestResult(testResult);
                                
                                // Se i cookie sono completamente invalidi, chiedi conferma
                                if (!testResult.valid) {
                                    const confirmProceed = confirm(
                                        'Cookie test failed: ' + testResult.message + '\\n\\n' +
                                        'Do you want to proceed anyway? Basic functionality will still work but personal playlists may not be available.'
                                    );
                                    if (!confirmProceed) {
                                        return;
                                    }
                                }
                                
                                // Se i cookie sono validi ma non autenticati, mostra warning
                                if (testResult.valid && !testResult.authenticated) {
                                    showWarning('Cookies are valid but authentication failed. Personal playlists may not work properly.');
                                }
                            }
                        }
                        
                        // Preparare la configurazione
                        let encryptedCookies = cookies.value;
                        
                        // Se i cookie non sono già criptati, crittali
                        if (!cookies.disabled && encryptedCookies) {
                            submitBtn.textContent = 'Encrypting...';
                            const encryptResponse = await fetch('/encrypt', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ auth: encryptedCookies })
                            });
                            
                            if (!encryptResponse.ok) {
                                throw new Error(await encryptResponse.text() || 'Encryption failed');
                            }
                            
                            encryptedCookies = await encryptResponse.text();
                        }

                        const config = {
                            encrypted: encryptedCookies,
                            catalogs: playlists.map(pl => ({ ...pl, id: ${JSON.stringify(prefix)} + pl.id })),
                            ...Object.fromEntries(
                                Array.from(addonSettings.querySelectorAll("input, select"))
                                    .map(x => [x.name, x.type === 'checkbox' ? x.checked : x.value])
                            )
                        };

                        let sessionId;
                        
                        if (isUpdatingSession && currentSessionId) {
                            // Aggiorna sessione esistente
                            submitBtn.textContent = 'Updating Session...';
                            
                            const updateResponse = await fetch(\`/session/\${currentSessionId}\`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ config, password })
                            });

                            if (!updateResponse.ok) {
                                const errorData = await updateResponse.json();
                                throw new Error(errorData.error || 'Failed to update session');
                            }

                            sessionId = currentSessionId;
                            showSuccess('Session updated successfully!');
                            
                        } else {
                            // Crea nuova sessione
                            submitBtn.textContent = 'Creating Session...';
                            
                            const sessionResponse = await fetch('/session', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ config, password })
                            });

                            if (!sessionResponse.ok) {
                                const errorData = await sessionResponse.json();
                                throw new Error(errorData.error || 'Failed to create session');
                            }

                            const sessionData = await sessionResponse.json();
                            sessionId = sessionData.sessionId;
                            
                            currentSessionId = sessionId;
                            isUpdatingSession = true;
                            
                            // Mostra l'ID della sessione nel campo
                            existingSessionInput.value = sessionId;
                            
                            submitBtn.textContent = 'Update Session';
                            showSuccess('Session created successfully!');
                        }

                        // Genera i link di installazione
                        const manifestUrl = \`\${window.location.protocol}//\${window.location.host}/\${sessionId}/manifest.json\`;
                        
                        installStremio.href = \`stremio://\${window.location.host}/\${sessionId}/manifest.json\`;
                        installUrlInput.value = manifestUrl;
                        installWeb.href = \`https://web.stremio.com/#/addons?addon=\${encodeURIComponent(manifestUrl)}\`;
                        
                        document.getElementById('results').style.display = 'block';
                        cookies.disabled = true;

                    } catch (error) {
                        showError(error.message);
                    } finally {
                        if (!isUpdatingSession) {
                            submitBtn.textContent = 'Create Session';
                        }
                        submitBtn.disabled = false;
                    }
                });

                // Funzione per caricare sessione con password (quando viene dal URL)
                async function loadSessionWithPassword(sessionId, password) {
                    try {
                        submitBtn.textContent = 'Loading Session...';
                        
                        // Carica la configurazione con password
                        const configResponse = await fetch(\`/session/\${sessionId}/config\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: password })
                        });
                        
                        if (!configResponse.ok) {
                            const errorData = await configResponse.json();
                            if (configResponse.status === 410) {
                                throw new Error('Session expired');
                            }
                            if (configResponse.status === 401) {
                                throw new Error('Invalid password');
                            }
                            throw new Error(errorData.error || 'Failed to load session');
                        }
                        
                        const sessionData = await configResponse.json();
                        
                        // Popola i campi con i dati della sessione
                        if (sessionData.config.encrypted) {
                            cookies.value = sessionData.config.encrypted;
                            cookies.disabled = true;
                        }
                        
                        if (sessionData.config.catalogs) {
                            playlists = sessionData.config.catalogs.map(pl => ({
                                ...pl,
                                id: pl.id.startsWith('${prefix}') ? pl.id.slice('${prefix}'.length) : pl.id
                            }));
                            renderPlaylists();
                        }
                        
                        // Imposta le altre opzioni
                        document.getElementById('markWatchedOnLoad').checked = sessionData.config.markWatchedOnLoad === true;
                        document.getElementById('search').checked = sessionData.config.search !== false;
                        document.getElementById('showBrokenLinks').checked = sessionData.config.showBrokenLinks === true;
                        
                        isUpdatingSession = true;
                        submitBtn.textContent = 'Update Session';
                        showSuccess('Session loaded successfully!');
                        
                        // Genera i link di installazione immediati
                        const manifestUrl = \`\${window.location.protocol}//\${window.location.host}/\${sessionId}/manifest.json\`;
                        installStremio.href = \`stremio://\${window.location.host}/\${sessionId}/manifest.json\`;
                        installUrlInput.value = manifestUrl;
                        installWeb.href = \`https://web.stremio.com/#/addons?addon=\${encodeURIComponent(manifestUrl)}\`;
                        document.getElementById('results').style.display = 'block';
                        
                    } catch (error) {
                        showError(\`Failed to load session: \${error.message}\`);
                        currentSessionId = null;
                        isUpdatingSession = false;
                        submitBtn.textContent = 'Create Session';
                    }
                }

                document.getElementById('copy-btn').addEventListener('click', async function() {
                    await navigator.clipboard.writeText(installUrlInput.value);
                    this.textContent = 'Copied!';
                    setTimeout(() => { this.textContent = 'Copy URL'; }, 2000);
                });
            </script>
        </body>
        </html>
    `);
});

// Error Handling Middleware
app.use((err, req, res, next) => {
    if (process.env.DEV_LOGGING) console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Pulizia sessioni scadute ogni ora
setInterval(async () => {
    try {
        await sessions.cleanupExpiredSessions();
    } catch (error) {
        console.error('[SESSIONS] Error during cleanup:', error);
    }
}, 60 * 60 * 1000); // 1 ora

// Start the Server
app.listen(PORT, () => {
    console.log(`Addon server running on port ${PORT}`);
    if (!process.env.ENCRYPTION_KEY) {
        console.warn('WARNING: Using random encryption key. Set ENCRYPTION_KEY environment variable for production.');
        if (process.env.DEV_LOGGING) console.warn('Generated key (base64):', ENCRYPTION_KEY.toString('base64'));
    }
    console.log(`Access the configuration page at: ${process.env.SPACE_HOST ? 'https://' + process.env.SPACE_HOST : 'http://localhost:' + PORT}`);
});
