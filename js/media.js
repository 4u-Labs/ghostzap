// ============================================================
// media.js — TalkMotion Secure Chat
// Processamento de imagens e arquivos (Canvas API)
// ============================================================

'use strict';

const TalkMedia = (() => {

    // Configurações de imagem
    const IMAGE_MAX_DIMENSION = 1920;
    const IMAGE_QUALITY       = 0.8;
    const IMAGE_MAX_SIZE      = 2 * 1024 * 1024; // 2MB
    const FILE_MAX_SIZE       = 10 * 1024 * 1024; // 10MB

    // Tipos de imagem aceitos
    const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

    // Tipos de arquivo aceitos
    const ALLOWED_FILE_TYPES = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain',
        'application/zip',
        'application/x-rar-compressed',
        'application/x-rar',
    ];

    // Extensões bloqueadas (executáveis)
    const BLOCKED_EXTENSIONS = ['.exe', '.bat', '.sh', '.php', '.js', '.cmd', '.ps1', '.vbs'];

    // --------------------------------------------------------
    // Processamento de Imagens
    // --------------------------------------------------------

    /**
     * Converte imagem para WebP, redimensionando se necessário
     * @param {File} file arquivo de imagem original
     * @returns {Promise<{blob, width, height, originalSize, finalSize}>}
     */
    async function convertImageToWebP(file) {
        if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
            throw new Error(`Tipo de imagem não suportado: ${file.type}. Use JPG, PNG ou WebP.`);
        }
        
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            
            img.onload = () => {
                URL.revokeObjectURL(url);
                
                // Calcular dimensões mantendo proporção
                let { width, height } = img;
                
                if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
                    const ratio = Math.min(
                        IMAGE_MAX_DIMENSION / width,
                        IMAGE_MAX_DIMENSION / height
                    );
                    width  = Math.round(width  * ratio);
                    height = Math.round(height * ratio);
                }
                
                // Renderizar no canvas
                const canvas = document.createElement('canvas');
                canvas.width  = width;
                canvas.height = height;
                
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // Converter para WebP (com fallback para JPEG se o navegador móvel não suportar encode WebP)
                canvas.toBlob(
                    (blob) => {
                        if (!blob) {
                            canvas.toBlob(
                                (jpegBlob) => {
                                    if (!jpegBlob) {
                                        reject(new Error('Erro ao converter imagem'));
                                        return;
                                    }
                                    resolve({
                                        blob: jpegBlob,
                                        width,
                                        height,
                                        originalSize: file.size,
                                        finalSize:    jpegBlob.size,
                                    });
                                },
                                'image/jpeg',
                                IMAGE_QUALITY
                            );
                            return;
                        }
                        
                        // Verificar tamanho final
                        if (blob.size > IMAGE_MAX_SIZE) {
                            reject(new Error(`Imagem muito grande após conversão: ${formatSize(blob.size)}. Máximo: 2MB`));
                            return;
                        }
                        
                        resolve({
                            blob,
                            width,
                            height,
                            originalSize: file.size,
                            finalSize:    blob.size,
                        });
                    },
                    'image/webp',
                    IMAGE_QUALITY
                );
            };
            
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Não foi possível carregar a imagem'));
            };
            
            img.src = url;
        });
    }

    /**
     * Cria preview de imagem como Data URL
     * @param {File|Blob} file
     * @returns {Promise<string>} data URL da imagem
     */
    async function createImagePreview(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Erro ao criar preview'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Converte blob para ArrayBuffer
     * @param {Blob} blob
     * @returns {Promise<ArrayBuffer>}
     */
    async function blobToArrayBuffer(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    }

    /**
     * Converte ArrayBuffer para Blob
     * @param {ArrayBuffer} buffer
     * @param {string} mimeType
     * @returns {Blob}
     */
    function arrayBufferToBlob(buffer, mimeType = 'application/octet-stream') {
        return new Blob([buffer], { type: mimeType });
    }

    /**
     * Converte ArrayBuffer para Data URL (otimizado para dispositivos móveis sem overflow de memória)
     * @param {ArrayBuffer} buffer
     * @param {string} mimeType
     * @returns {string} data URL
     */
    function arrayBufferToDataUrl(buffer, mimeType = 'image/webp') {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return `data:${mimeType};base64,${btoa(binary)}`;
    }

    // --------------------------------------------------------
    // Validação de Arquivos
    // --------------------------------------------------------

    /**
     * Valida arquivo para envio
     * @param {File} file
     * @returns {{valid: boolean, error?: string, type: 'image'|'file'}}
     */
    function validateFile(file) {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        
        // Verificar extensões bloqueadas
        if (BLOCKED_EXTENSIONS.includes(ext)) {
            return { valid: false, error: `Tipo de arquivo bloqueado: ${ext}` };
        }
        
        // Verificar se é imagem
        if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
            if (file.size > IMAGE_MAX_SIZE * 5) { // Margem antes de converter
                return { valid: false, error: `Imagem muito grande: ${formatSize(file.size)}. Máximo: ~10MB antes de converter` };
            }
            return { valid: true, type: 'image' };
        }
        
        // Verificar se é arquivo permitido
        if (ALLOWED_FILE_TYPES.includes(file.type)) {
            if (file.size > FILE_MAX_SIZE) {
                return { valid: false, error: `Arquivo muito grande: ${formatSize(file.size)}. Máximo: 10MB` };
            }
            return { valid: true, type: 'file' };
        }
        
        return { valid: false, error: `Tipo não permitido: ${file.type || ext}` };
    }

    // --------------------------------------------------------
    // Utilitários
    // --------------------------------------------------------

    /**
     * Formata tamanho de arquivo legível
     * @param {number} bytes
     * @returns {string}
     */
    function formatSize(bytes) {
        if (bytes < 1024)       return `${bytes} B`;
        if (bytes < 1024**2)   return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024**3)   return `${(bytes / 1024**2).toFixed(1)} MB`;
        return `${(bytes / 1024**3).toFixed(1)} GB`;
    }

    /**
     * Gera ID único para arquivo
     * @returns {string}
     */
    function generateFileId() {
        return 'file_' + Date.now() + '_' + Math.random().toString(36).substring(2);
    }

    /**
     * Detecta tipo MIME de dados binários
     * @param {ArrayBuffer} buffer
     * @returns {string}
     */
    function detectMimeType(buffer) {
        const bytes = new Uint8Array(buffer.slice(0, 4));
        const hex   = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        
        const signatures = {
            'ffd8ff':     'image/jpeg',
            '89504e47':   'image/png',
            '52494646':   'image/webp', // RIFF
            '25504446':   'application/pdf',
            '504b0304':   'application/zip',
        };
        
        for (const [sig, type] of Object.entries(signatures)) {
            if (hex.startsWith(sig)) return type;
        }
        
        return 'application/octet-stream';
    }

    /**
     * Cria thumbnail pequeno de uma imagem (para lista de conversas)
     * @param {string} dataUrl
     * @param {number} size tamanho do thumbnail em px
     * @returns {Promise<string>} data URL do thumbnail
     */
    async function createThumbnail(dataUrl, size = 100) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width  = size;
                canvas.height = size;
                
                const ctx = canvas.getContext('2d');
                
                // Corte centralizado (cover)
                const ratio = Math.max(size / img.width, size / img.height);
                const w     = img.width  * ratio;
                const h     = img.height * ratio;
                const x     = (size - w) / 2;
                const y     = (size - h) / 2;
                
                ctx.drawImage(img, x, y, w, h);
                resolve(canvas.toDataURL('image/webp', 0.6));
            };
            img.src = dataUrl;
        });
    }

    // API pública
    return {
        convertImageToWebP,
        createImagePreview,
        blobToArrayBuffer,
        arrayBufferToBlob,
        arrayBufferToDataUrl,
        validateFile,
        formatSize,
        generateFileId,
        detectMimeType,
        createThumbnail,
        ALLOWED_IMAGE_TYPES,
        ALLOWED_FILE_TYPES,
        IMAGE_MAX_SIZE,
        FILE_MAX_SIZE,
    };

})();
