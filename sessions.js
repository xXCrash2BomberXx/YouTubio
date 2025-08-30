const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const SESSIONS_DIR = process.env.SESSIONS_DIR || './data/sessions';
const SESSION_EXPIRY_DAYS = parseInt(process.env.SESSION_EXPIRY_DAYS) || 30;

// Assicurati che la directory delle sessioni esista
async function ensureSessionsDir() {
    try {
        await fs.mkdir(SESSIONS_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
}

// Genera un ID sessione unico
function generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

// Hash della password per sicurezza
function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 10000, 32, 'sha256').toString('hex');
}

// Crea una nuova sessione
async function createSession(config, password) {
    await ensureSessionsDir();
    
    const sessionId = generateSessionId();
    const salt = crypto.randomBytes(16).toString('hex');
    const hashedPassword = hashPassword(password, salt);
    
    const sessionData = {
        id: sessionId,
        config: config,
        passwordHash: hashedPassword,
        salt: salt,
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
    };
    
    const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
    await fs.writeFile(sessionFile, JSON.stringify(sessionData, null, 2));
    
    return sessionId;
}

// Verifica la password per una sessione
function verifyPassword(password, hash, salt) {
    const hashedInput = hashPassword(password, salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashedInput, 'hex'));
}

// Recupera una sessione esistente
async function getSession(sessionId, password = null) {
    try {
        const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
        const sessionData = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
        
        const now = new Date();
        const expiresAt = new Date(sessionData.expiresAt);
        
        // Verifica se la sessione è scaduta
        if (now > expiresAt) {
            console.log(`[SESSIONS] Expired session accessed: ${sessionId} (expired on ${expiresAt.toISOString()})`);
            // Non eliminiamo automaticamente, lasciamo che sia il cleanup a farlo
            return { expired: true, sessionId };
        }
        
        // Se è richiesta una password, verificala
        if (password !== null && !verifyPassword(password, sessionData.passwordHash, sessionData.salt)) {
            return null;
        }
        
        // Aggiorna il timestamp di ultimo accesso e rinnova la scadenza
        sessionData.lastAccessed = now.toISOString();
        sessionData.expiresAt = new Date(now.getTime() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
        
        await fs.writeFile(sessionFile, JSON.stringify(sessionData, null, 2));
        
        return sessionData;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null; // Sessione non trovata
        }
        throw error;
    }
}

// Aggiorna una sessione esistente
async function updateSession(sessionId, password, newConfig) {
    const sessionData = await getSession(sessionId, password);
    if (!sessionData) {
        return false;
    }
    
    sessionData.config = newConfig;
    sessionData.lastAccessed = new Date().toISOString();
    
    const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
    await fs.writeFile(sessionFile, JSON.stringify(sessionData, null, 2));
    
    return true;
}

// Elimina una sessione
async function deleteSession(sessionId, password = null) {
    try {
        if (password !== null) {
            const sessionData = await getSession(sessionId, password);
            if (!sessionData) {
                return false;
            }
        }
        
        const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
        await fs.unlink(sessionFile);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false; // Sessione già eliminata
        }
        throw error;
    }
}

// Pulizia sessioni scadute (da chiamare periodicamente)
async function cleanupExpiredSessions() {
    try {
        await ensureSessionsDir();
        const files = await fs.readdir(SESSIONS_DIR);
        const now = new Date();
        let cleaned = 0;
        
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            
            try {
                const sessionFile = path.join(SESSIONS_DIR, file);
                const sessionData = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
                
                if (now > new Date(sessionData.expiresAt)) {
                    await fs.unlink(sessionFile);
                    cleaned++;
                }
            } catch (error) {
                // Ignora errori sui singoli file
                console.warn(`Error processing session file ${file}:`, error.message);
            }
        }
        
        if (cleaned > 0) {
            console.log(`Cleaned up ${cleaned} expired sessions`);
        }
        
        return cleaned;
    } catch (error) {
        console.error('Error during cleanup:', error);
        return 0;
    }
}

// Lista tutte le sessioni (per debug/admin)
async function listSessions() {
    try {
        await ensureSessionsDir();
        const files = await fs.readdir(SESSIONS_DIR);
        const sessions = [];
        
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            
            try {
                const sessionFile = path.join(SESSIONS_DIR, file);
                const sessionData = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
                sessions.push({
                    id: sessionData.id,
                    createdAt: sessionData.createdAt,
                    lastAccessed: sessionData.lastAccessed,
                    expiresAt: sessionData.expiresAt,
                    configSize: JSON.stringify(sessionData.config).length
                });
            } catch (error) {
                // Ignora errori sui singoli file
            }
        }
        
        return sessions;
    } catch (error) {
        console.error('Error listing sessions:', error);
        return [];
    }
}

// Verifica se una stringa è un ID sessione valido (32 caratteri hex)
function isValidSessionId(str) {
    return /^[a-f0-9]{32}$/i.test(str);
}

module.exports = {
    createSession,
    getSession,
    updateSession,
    deleteSession,
    cleanupExpiredSessions,
    listSessions,
    isValidSessionId
};