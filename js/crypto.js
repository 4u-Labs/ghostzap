// ============================================================
// crypto.js — TalkMotion Secure Chat
// Criptografia ponta-a-ponta usando Web Crypto API
// A chave privada NUNCA sai do navegador
// ============================================================

'use strict';

const TalkCrypto = (() => {

    // --------------------------------------------------------
    // Geração de par de chaves RSA-OAEP
    // --------------------------------------------------------

    /**
     * Gera par de chaves criptográficas no navegador
     * RSA-OAEP 4096 bits com SHA-256
     * @returns {Promise<{publicKey, privateKey}>}
     */
    async function generateKeyPair() {
        const keyPair = await window.crypto.subtle.generateKey(
            {
                name:           'RSA-OAEP',
                modulusLength:  4096,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash:           'SHA-256',
            },
            true,  // exportável
            ['encrypt', 'decrypt']
        );
        return keyPair;
    }

    /**
     * Exporta chave pública para formato base64 (para enviar ao servidor)
     * @param {CryptoKey} publicKey
     * @returns {Promise<string>} base64
     */
    async function exportPublicKey(publicKey) {
        const exported  = await window.crypto.subtle.exportKey('spki', publicKey);
        const bytes     = new Uint8Array(exported);
        const binary    = bytes.reduce((acc, b) => acc + String.fromCharCode(b), '');
        return btoa(binary);
    }

    /**
     * Exporta chave privada criptografada com senha do usuário
     * Usada para backup/recuperação da chave no mesmo dispositivo
     * @param {CryptoKey} privateKey
     * @param {string} password senha para proteger exportação
     * @returns {Promise<string>} JSON cifrado em base64
     */
    async function exportPrivateKey(privateKey, password) {
        // Exportar chave privada em formato JWK
        const jwk = await window.crypto.subtle.exportKey('jwk', privateKey);
        
        // Derivar chave de criptografia a partir da senha
        const encKey = await deriveKeyFromPassword(password);
        
        // Cifrar o JWK
        const iv  = window.crypto.getRandomValues(new Uint8Array(12));
        const enc = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            encKey.key,
            new TextEncoder().encode(JSON.stringify(jwk))
        );
        
        return JSON.stringify({
            iv:      arrayToBase64(iv),
            data:    arrayToBase64(new Uint8Array(enc)),
            salt:    arrayToBase64(encKey.salt),
        });
    }

    /**
     * Importa chave pública a partir do base64 (recebida do servidor)
     * @param {string} base64 chave pública em SPKI/base64
     * @returns {Promise<CryptoKey>}
     */
    async function importPublicKey(base64) {
        const binary  = atob(base64);
        const bytes   = new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
        
        return window.crypto.subtle.importKey(
            'spki',
            bytes.buffer,
            { name: 'RSA-OAEP', hash: 'SHA-256' },
            false,
            ['encrypt']
        );
    }

    /**
     * Importa chave privada a partir de exportação cifrada
     * @param {string} exportedJson resultado de exportPrivateKey()
     * @param {string} password senha usada na exportação
     * @returns {Promise<CryptoKey>}
     */
    async function importPrivateKey(exportedJson, password) {
        const { iv, data, salt } = JSON.parse(exportedJson);
        
        const encKey = await deriveKeyFromPassword(password, base64ToArray(salt));
        
        const decrypted = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: base64ToArray(iv) },
            encKey.key,
            base64ToArray(data)
        );
        
        const jwk = JSON.parse(new TextDecoder().decode(decrypted));
        
        return window.crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'RSA-OAEP', hash: 'SHA-256' },
            false,
            ['decrypt']
        );
    }

    // --------------------------------------------------------
    // Criptografia Híbrida (RSA + AES)
    // Usada para mensagens maiores (arquivos, imagens)
    // --------------------------------------------------------

    /**
     * Criptografa mensagem para um destinatário usando sua chave pública
     * Esquema: AES-GCM (chave aleatória) + RSA-OAEP (para chave AES)
     * @param {string|Uint8Array} plaintext conteúdo a criptografar
     * @param {CryptoKey} recipientPublicKey chave pública do destinatário
     * @returns {Promise<string>} JSON base64 cifrado
     */
    async function encryptMessage(plaintext, recipientPublicKey) {
        // 1. Gerar chave AES-GCM aleatória para este payload
        const aesKey = await window.crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
        
        // 2. Criptografar conteúdo com AES-GCM
        const iv      = window.crypto.getRandomValues(new Uint8Array(12));
        const content = typeof plaintext === 'string'
            ? new TextEncoder().encode(plaintext)
            : plaintext;
        
        const ciphertext = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            content
        );
        
        // 3. Exportar chave AES e criptografar com RSA público do destinatário
        const rawAesKey      = await window.crypto.subtle.exportKey('raw', aesKey);
        const encryptedAesKey = await window.crypto.subtle.encrypt(
            { name: 'RSA-OAEP' },
            recipientPublicKey,
            rawAesKey
        );
        
        // 4. Montar payload final
        return JSON.stringify({
            v:   1,                                          // versão do protocolo
            ek:  arrayToBase64(new Uint8Array(encryptedAesKey)), // chave AES cifrada
            iv:  arrayToBase64(iv),
            ct:  arrayToBase64(new Uint8Array(ciphertext)),  // conteúdo cifrado
        });
    }

    /**
     * Descriptografa mensagem usando a chave privada do usuário
     * @param {string} encryptedJson resultado de encryptMessage()
     * @param {CryptoKey} privateKey chave privada do usuário (nunca sai do browser)
     * @returns {Promise<Uint8Array>} conteúdo original
     */
    async function decryptMessage(encryptedJson, privateKey) {
        const { v, ek, iv, ct } = JSON.parse(encryptedJson);
        
        if (v !== 1) throw new Error('Versão de protocolo desconhecida');
        
        // 1. Descriptografar a chave AES com a chave RSA privada
        const rawAesKey = await window.crypto.subtle.decrypt(
            { name: 'RSA-OAEP' },
            privateKey,
            base64ToArray(ek)
        );
        
        // 2. Importar chave AES
        const aesKey = await window.crypto.subtle.importKey(
            'raw',
            rawAesKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
        
        // 3. Descriptografar conteúdo
        const plaintext = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: base64ToArray(iv) },
            aesKey,
            base64ToArray(ct)
        );
        
        return new Uint8Array(plaintext);
    }

    /**
     * Descriptografa mensagem como string de texto
     * @param {string} encryptedJson
     * @param {CryptoKey} privateKey
     * @returns {Promise<string>}
     */
    async function decryptMessageText(encryptedJson, privateKey) {
        const bytes = await decryptMessage(encryptedJson, privateKey);
        return new TextDecoder().decode(bytes);
    }

    // --------------------------------------------------------
    // Fingerprint para verificação MITM
    // --------------------------------------------------------

    /**
     * Gera fingerprint visual da chave pública
     * Permite que usuários verifiquem autenticidade da chave
     * @param {string} publicKeyBase64
     * @returns {Promise<string>} fingerprint formatado "XXXX-XXXX-XXXX-XXXX"
     */
    async function generateFingerprint(publicKeyBase64) {
        const encoder = new TextEncoder();
        const data    = encoder.encode(publicKeyBase64);
        const hash    = await window.crypto.subtle.digest('SHA-256', data);
        const hex     = Array.from(new Uint8Array(hash))
                            .map(b => b.toString(16).padStart(2, '0'))
                            .join('');
        
        // Formatar como grupos de 4 caracteres maiúsculos
        const groups = [];
        for (let i = 0; i < 16; i += 4) {
            groups.push(hex.substring(i, i + 4).toUpperCase());
        }
        return groups.join('-');
    }

    // --------------------------------------------------------
    // Utilitários internos
    // --------------------------------------------------------

    /**
     * Deriva chave AES-GCM de senha usando PBKDF2
     */
    async function deriveKeyFromPassword(password, salt = null) {
        const saltBytes = salt ?? window.crypto.getRandomValues(new Uint8Array(16));
        
        const baseKey = await window.crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        
        const key = await window.crypto.subtle.deriveKey(
            {
                name:       'PBKDF2',
                salt:       saltBytes,
                iterations: 100000,
                hash:       'SHA-256',
            },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        
        return { key, salt: saltBytes };
    }

    /** Converte Uint8Array para base64 */
    function arrayToBase64(bytes) {
        return btoa(Array.from(bytes).map(b => String.fromCharCode(b)).join(''));
    }

    /** Converte base64 para Uint8Array */
    function base64ToArray(base64) {
        const binary = atob(base64);
        return new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
    }

    /**
     * Gera frase de recuperação (mnemônica) de 12 palavras
     */
    function generateRecoveryPhrase() {
        const words = [
            'ghost', 'zap', 'safe', 'chat', 'private', 'secure', 'crypto', 'shadow', 'secret', 'phantom',
            'spirit', 'stealth', 'hidden', 'silent', 'mask', 'veil', 'shield', 'guard', 'lock', 'vault',
            'key', 'code', 'logic', 'cyber', 'data', 'cloud', 'node', 'mesh', 'link', 'pulse',
            'wave', 'storm', 'wind', 'fire', 'water', 'earth', 'stone', 'iron', 'gold', 'silver',
            'moon', 'sun', 'stars', 'galaxy', 'orbit', 'space', 'time', 'flow', 'void', 'pure',
            'bright', 'dark', 'light', 'neon', 'glow', 'flash', 'bolt', 'spark', 'laser', 'beam',
            'alpha', 'beta', 'delta', 'omega', 'zenith', 'apex', 'core', 'base', 'origin', 'root',
            'leaf', 'tree', 'forest', 'jungle', 'desert', 'ocean', 'river', 'lake', 'peak', 'plain',
            'city', 'world', 'land', 'island', 'map', 'path', 'bridge', 'gate', 'door', 'home',
            'heart', 'mind', 'soul', 'spirit', 'dream', 'hope', 'life', 'peace', 'truth', 'faith',
            'brave', 'strong', 'swift', 'sharp', 'smart', 'wise', 'calm', 'wild', 'free', 'bold',
            'magic', 'vibe', 'aura', 'echo', 'rhythm', 'beat', 'vocal', 'tune', 'song', 'epic',
            'north', 'south', 'east', 'west', 'up', 'down', 'left', 'right', 'near', 'far'
        ];
        const res = [];
        const randomValues = new Uint32Array(12);
        window.crypto.getRandomValues(randomValues);
        for (let i = 0; i < 12; i++) {
            res.push(words[randomValues[i] % words.length]);
        }
        return res.join(' ');
    }

    /**
     * Criptografa a chave privada usando a frase de recuperação
     */
    async function encryptPrivateKeyForBackup(privateKey, phrase) {
        const jwk    = await window.crypto.subtle.exportKey('jwk', privateKey);
        const encKey = await deriveKeyFromPassword(phrase + 'ghostzap_backup_salt');
        const iv     = window.crypto.getRandomValues(new Uint8Array(12));
        const enc    = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            encKey.key,
            new TextEncoder().encode(JSON.stringify(jwk))
        );
        return JSON.stringify({
            iv:   arrayToBase64(iv),
            data: arrayToBase64(new Uint8Array(enc)),
            salt: arrayToBase64(encKey.salt)
        });
    }

    /**
     * Descriptografa a chave privada usando a frase de recuperação
     */
    async function decryptPrivateKeyFromBackup(backupBlob, phrase) {
        try {
            const { iv, data, salt } = JSON.parse(backupBlob);
            const encKey = await deriveKeyFromPassword(phrase + 'ghostzap_backup_salt', base64ToArray(salt));
            const decrypted = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: base64ToArray(iv) },
                encKey.key,
                base64ToArray(data)
            );
            const jwk = JSON.parse(new TextDecoder().decode(decrypted));
            return window.crypto.subtle.importKey(
                'jwk',
                jwk,
                { name: 'RSA-OAEP', hash: 'SHA-256' },
                false,
                ['decrypt']
            );
        } catch (e) {
            throw new Error('Frase de recuperação inválida ou backup corrompido.');
        }
    }

    // --------------------------------------------------------
    // Criptografia em Repouso para Storage Local (IndexedDB)
    // --------------------------------------------------------

    /**
     * Deriva chave AES-GCM 256-bit para criptografia do IndexedDB local
     * @param {string} secret PIN ou chave mestra do usuário
     * @param {Uint8Array} [salt]
     * @returns {Promise<{key: CryptoKey, salt: Uint8Array}>}
     */
    async function deriveStorageKey(secret, salt = null) {
        return await deriveKeyFromPassword(secret + '_ghostzap_storage_salt_v1', salt);
    }

    /**
     * Criptografa dados em repouso para o IndexedDB
     * @param {string|object} data
     * @param {CryptoKey} key
     * @returns {Promise<string>}
     */
    async function encryptStorageData(data, key) {
        if (!key) return (typeof data === 'string' ? data : JSON.stringify(data));
        const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
        const encoded = new TextEncoder().encode(jsonStr);
        const iv      = window.crypto.getRandomValues(new Uint8Array(12));
        const enc     = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            encoded
        );
        return JSON.stringify({
            _enc: 1,
            iv:   arrayToBase64(iv),
            ct:   arrayToBase64(new Uint8Array(enc))
        });
    }

    /**
     * Descriptografa dados em repouso do IndexedDB
     * @param {string} encryptedBlob
     * @param {CryptoKey} key
     * @returns {Promise<any>}
     */
    async function decryptStorageData(encryptedBlob, key) {
        if (!encryptedBlob || typeof encryptedBlob !== 'string') return encryptedBlob;
        if (!encryptedBlob.startsWith('{"_enc":1')) return encryptedBlob; // Não criptografado (legado)
        try {
            const { iv, ct } = JSON.parse(encryptedBlob);
            const dec = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: base64ToArray(iv) },
                key,
                base64ToArray(ct)
            );
            const text = new TextDecoder().decode(dec);
            try {
                return JSON.parse(text);
            } catch (e) {
                return text;
            }
        } catch (err) {
            console.error('Falha ao decifrar registro do storage:', err);
            return null;
        }
    }

    /**
     * Adiciona preenchimento aleatório (Traffic Padding) para ofuscar tamanho de pacotes
     * @param {string} text
     * @param {number} blockSize Tamanho de bloco desejado (ex: 512 bytes)
     * @returns {string} JSON envelope com payload + padding
     */
    function addTrafficPadding(text, blockSize = 512) {
        const textLen = new TextEncoder().encode(text).length;
        const targetLen = Math.max(blockSize, Math.ceil((textLen + 32) / blockSize) * blockSize);
        const padLen = Math.max(8, targetLen - textLen - 24);
        const padChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let pad = '';
        for (let i = 0; i < padLen; i++) {
            pad += padChars.charAt(Math.floor(Math.random() * padChars.length));
        }
        return JSON.stringify({ _p: text, _pad: pad });
    }

    /**
     * Remove preenchimento de tráfego (Traffic Padding)
     * @param {string} rawText
     * @returns {string}
     */
    function removeTrafficPadding(rawText) {
        if (!rawText || typeof rawText !== 'string') return rawText;
        if (rawText.startsWith('{"_p":')) {
            try {
                const parsed = JSON.parse(rawText);
                if (typeof parsed._p !== 'undefined') return parsed._p;
            } catch (e) {}
        }
        return rawText;
    }

    // API pública
    return {
        generateKeyPair,
        exportPublicKey,
        exportPrivateKey,
        importPublicKey,
        importPrivateKey,
        encryptMessage,
        decryptMessage,
        decryptMessageText,
        generateFingerprint,
        generateRecoveryPhrase,
        encryptPrivateKeyForBackup,
        decryptPrivateKeyFromBackup,
        deriveStorageKey,
        encryptStorageData,
        decryptStorageData,
        addTrafficPadding,
        removeTrafficPadding,
        arrayToBase64,
        base64ToArray,
    };

})();
