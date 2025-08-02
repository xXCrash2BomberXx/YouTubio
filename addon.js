#!/usr/bin/env node

const express = require('express');
const qs = require('querystring');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const ytDlpWrap = new YTDlpWrap();
const PORT = process.env.PORT || 7000;

const manifest = {
    id: 'xxcrashbomberxx-youtube.hf.space',
    version: '0.1.0',
    name: 'YouTube',
    description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
    logo: 'https://www.youtube.com/s/desktop/d743f786/img/favicon_144x144.png',
    resources: ['catalog', 'stream', 'meta'],
    types: ['channel'],
    idPrefixes: ['yt:'],
    catalogs: [
        { type: 'channel', id: 'youtube.discover', name: 'Discover' },
        { type: 'channel', id: 'youtube.subscriptions', name: 'Subscriptions' },
        { type: 'channel', id: 'youtube.watchlater', name: 'Watch Later' },
        { type: 'channel', id: 'youtube.history', name: 'History' },
        { type: 'channel', id: 'youtube.search', name: 'YouTube', extra: [{ name: 'search', isRequired: true }] },
    ],
    config: {
        "type": "url",
        "label": "Login with Google",
        "url": `https://${process.env.SPACE_HOST}`
    }
};

const app = express();

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Stremio Addon Manifest Route
app.get('/:config/manifest.json', (req, res) => {
    res.json(manifest);
});

// Stremio Addon Resource Route
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
    const args = {
        type: req.params.type,
        id: req.params.id,
        extra: (req.params.extra ? qs.parse(req.params.extra) : {})
    };
    try {
        // Handle search catalogs
        if (args.id === 'youtube.search' && args.extra && args.extra.search) {
            try {
                const searchQuery = `ytsearch50:${args.extra.search}`;
                const searchInfo = await ytDlpWrap.getVideoInfo([
                    searchQuery,
                    '-J'
                ]);
                const searchData = JSON.parse(searchInfo);
                const metas = searchData.entries.map(video => {
                    if (!video) return null;
                    const posterUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0] ? video.thumbnails[0].url : null);
                    const releaseYear = video.upload_date ? video.upload_date.substring(0, 4) : null;
                    return {
                        id: `yt:${video.id}`,
                        type: 'channel',
                        name: video.title || 'Unknown Title',
                        poster: posterUrl,
                        posterShape: 'landscape',
                        description: video.description || '',
                        releaseInfo: releaseYear
                    };
                }).filter(meta => meta !== null);
                return res.json({ metas });
            } catch (err) {
                console.error('Error in search handler:', err.message);
                return res.json({ metas: [] });
            }
        }
        // Handle discover catalog
        else if (args.id === 'youtube.discover') {
            try {
                const trendingInfo = await ytDlpWrap.getVideoInfo([
                    'https://www.youtube.com/feed/trending',
                    '-J'
                ]);
                const trendingData = JSON.parse(trendingInfo);
                const metas = trendingData.entries.map(video => {
                    if (!video) return null;
                    const posterUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0] ? video.thumbnails[0].url : null);
                    const releaseYear = video.upload_date ? video.upload_date.substring(0, 4) : null;
                    return {
                        id: `yt:${video.id}`,
                        type: 'channel',
                        name: video.title || 'Unknown Title',
                        poster: posterUrl,
                        posterShape: 'landscape',
                        description: video.description || '',
                        releaseInfo: releaseYear
                    };
                }).filter(meta => meta !== null);
                return res.json({ metas });
            } catch (err) {
                console.error('Error in discover handler:', err.message);
                return res.json({ metas: [] });
            }
        }
        // Handle subscriptions catalog
        else if (args.id === 'youtube.subscriptions') {
            if (!userConfig.cookies) {
                return res.json({ metas: [] });
            }
            let cookieFile = null;
            try {
                const tempDir = os.tmpdir();
                cookieFile = path.join(tempDir, `cookies_${Date.now()}.txt`);
                await fs.writeFile(cookieFile, userConfig.cookies);
                const subsInfo = await ytDlpWrap.getVideoInfo([
                    'https://www.youtube.com/feed/subscriptions',
                    '--cookies', cookieFile,
                    '-J'
                ]);
                const subsData = JSON.parse(subsInfo);
                const metas = subsData.entries.map(video => {
                    if (!video) return null;
                    const posterUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0] ? video.thumbnails[0].url : null);
                    const releaseYear = video.upload_date ? video.upload_date.substring(0, 4) : null;
                    return {
                        id: `yt:${video.id}`,
                        type: 'channel',
                        name: video.title || 'Unknown Title',
                        poster: posterUrl,
                        posterShape: 'landscape',
                        description: video.description || '',
                        releaseInfo: releaseYear
                    };
                }).filter(meta => meta !== null);
                return res.json({ metas });
            } catch (err) {
                console.error('Error in subscriptions handler:', err.message);
                return res.json({ metas: [] });
            } finally {
                if (cookieFile) {
                    await fs.unlink(cookieFile).catch(err => console.error('Error deleting temp cookie file:', err));
                }
            }
        }
        // Handle watch later catalog
        else if (args.id === 'youtube.watchlater') {
            if (!userConfig.cookies) {
                return res.json({ metas: [] });
            }
            let cookieFile = null;
            try {
                const tempDir = os.tmpdir();
                cookieFile = path.join(tempDir, `cookies_${Date.now()}.txt`);
                await fs.writeFile(cookieFile, userConfig.cookies);
                const playlistInfo = await ytDlpWrap.getVideoInfo([
                    'https://www.youtube.com/playlist?list=WL',
                    '--cookies', cookieFile,
                    '-J'
                ]);
                const playlistData = JSON.parse(playlistInfo);
                const metas = playlistData.entries.map(video => {
                    if (!video) return null;
                    const posterUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0] ? video.thumbnails[0].url : null);
                    const releaseYear = video.upload_date ? video.upload_date.substring(0, 4) : null;
                    return {
                        id: `yt:${video.id}`,
                        type: 'channel',
                        name: video.title || 'Unknown Title',
                        poster: posterUrl,
                        posterShape: 'landscape',
                        description: video.description || '',
                        releaseInfo: releaseYear
                    };
                }).filter(meta => meta !== null);
                return res.json({ metas });
            } catch (err) {
                console.error('Error in watchlater handler:', err.message);
                return res.json({ metas: [] });
            } finally {
                if (cookieFile) {
                    await fs.unlink(cookieFile).catch(err => console.error('Error deleting temp cookie file:', err));
                }
            }
        }
        // Handle Watch History catalog
        else if (args.id === 'youtube.history') {
            if (!userConfig.cookies) {
                return res.json({ metas: [] });
            }
            let cookieFile = null;
            try {
                const tempDir = os.tmpdir();
                cookieFile = path.join(tempDir, `cookies_${Date.now()}.txt`);
                await fs.writeFile(cookieFile, userConfig.cookies);
                const historyInfo = await ytDlpWrap.getVideoInfo([
                    'https://www.youtube.com/feed/history',
                    '--cookies', cookieFile,
                    '-J'
                ]);
                const historyData = JSON.parse(historyInfo);
                const metas = historyData.entries.map(video => {
                    if (!video) return null;
                    const posterUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0] ? video.thumbnails[0].url : null);
                    const releaseYear = video.upload_date ? video.upload_date.substring(0, 4) : null;
                    return {
                        id: `yt:${video.id}`,
                        type: 'channel',
                        name: video.title || 'Unknown Title',
                        poster: posterUrl,
                        posterShape: 'landscape',
                        description: video.description || '',
                        releaseInfo: releaseYear
                    };
                }).filter(meta => meta !== null);
                return res.json({ metas });
            } catch (err) {
                console.error('Error in history handler:', err.message);
                return res.json({ metas: [] });
            } finally {
                if (cookieFile) {
                    await fs.unlink(cookieFile).catch(err => console.error('Error deleting temp cookie file:', err));
                }
            }
        }
    } catch (err) {
        console.error('Error in catalog handler:', err.message);
        console.error('Full error:', err);
        return res.json({metas: []});
    }
});

// Stremio Addon Meta Route
app.get('/:config/meta/:type/:id.json', async (req, res) => {
    const args = {
        type: req.params.type,
        id: req.params.id,
    };
    if (args.id.startsWith('yt:')) {
        const videoId = args.id.slice(3);
        try {
            const videoInfo = await ytDlpWrap.getVideoInfo([
                `https://www.youtube.com/watch?v=${videoId}`,
                '-J'
            ]);
            const videoData = JSON.parse(videoInfo);
            const posterUrl = videoData.thumbnail || (videoData.thumbnails && videoData.thumbnails[0] ? videoData.thumbnails[0].url : null);
            const releaseYear = videoData.upload_date ? videoData.upload_date.substring(0, 4) : null;
            const meta = {
                id: `yt:${videoData.id}`,
                type: 'channel',
                name: videoData.title || 'Unknown Title',
                poster: posterUrl,
                posterShape: 'landscape',
                description: videoData.description || '',
                releaseInfo: releaseYear
            };
            return res.json({ meta });
        } catch (err) {
            console.error('Error in meta handler:', err.message);
            return res.json({ meta: {} });
        }
    }
    return res.json({ meta: {} });
});

// Stremio Addon Stream Route
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const args = {
        type: req.params.type,
        id: req.params.id,
    };
    if (args.id.startsWith('yt:')) {
        const videoId = args.id.slice(3);
        let cookieFile = null;
        try {
            const jsonString = Buffer.from(req.params.config, 'base64').toString('utf-8');
            const userConfig = JSON.parse(jsonString);
            const ytDlpArgs = [];
            if (userConfig.cookies) {
                const tempDir = os.tmpdir();
                cookieFile = path.join(tempDir, `cookies_${Date.now()}.txt`);
                await fs.writeFile(cookieFile, userConfig.cookies);
                ytDlpArgs.push('--cookies', cookieFile);
            }
            const videoInfo = await ytDlpWrap.getVideoInfo([`https://www.youtube.com/watch?v=${videoId}`].concat(ytDlpArgs));
            const format = videoInfo.formats.find(f => f.format_id === 'best' || (f.acodec !== 'none' && f.vcodec !== 'none'));
            if (format) {
                res.json({
                    streams: [{
                        title: 'YouTube Stream',
                        url: format.url,
                        description: 'Click to watch on YouTube'
                    }]
                });
            } else {
                 res.json({ streams: [] });
            }
        } catch (err) {
            console.error('Error getting video info:', err.message);
            res.json({ streams: [] });
        } finally {
            if (cookieFile) {
                await fs.unlink(cookieFile).catch(err => console.error('Error deleting temp cookie file:', err));
            }
        }
    } else {
        res.json({ streams: [] });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Addon server running on port ${PORT}`);
    console.log(`Access it at: https://${process.env.SPACE_HOST}`);
});
    