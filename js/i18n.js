/**
 * GhostZap i18n — Gerenciador de Multilinguagem
 * Suporta PT, EN, ES e detecção automática
 */
const TalkI18n = {
    currentLang: 'pt',
    dictionary: {},

    // Suportados
    supported: ['pt', 'en', 'es', 'zh'],
    
    /**
     * Retorna a tradução de uma chave
     */
    t(key) {
        return this.dictionary[key] || '';
    },

    async init() {
        // 1. Prioridade: localStorage (escolha manual)
        let lang = localStorage.getItem('ghostzap_lang');

        // 2. Se não houver escolha manual, detecta navegador
        if (!lang) {
            // Normaliza pt-BR, pt_BR, PT-br para apenas "pt"
            const browserLang = (navigator.language || 'en').replace('_', '-').split('-')[0].toLowerCase();
            lang = this.supported.includes(browserLang) ? browserLang : 'en';
        }

        await this.setLanguage(lang, true);
        this.updateActiveUI();
    },

    async setLanguage(lang, savePreference = true) {
        if (!this.supported.includes(lang)) lang = 'en';
        
        try {
            console.log(`🌍 GhostZap: Fetching [${lang}]...`);
            const res = await fetch(`lang/${lang}.json?v=${new Date().getTime()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            this.dictionary = await res.json();
            this.currentLang = lang;
            
            if (savePreference) {
                localStorage.setItem('ghostzap_lang', lang);
            }
            
            this.applyTranslations();
            this.updateActiveUI();
            console.log(`🌍 GhostZap: Language set to [${lang}]`);
        } catch (e) {
            console.error('🌍 GhostZap: Error loading language:', e);
            // Se falhou o PT e não temos nada, carrega EN como fallback final
            if (lang !== 'en') this.setLanguage('en', false);
        }
    },

    /**
     * Varre o DOM procurando elementos com [data-i18n]
     */
    applyTranslations(root = document) {
        root.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (this.dictionary[key]) {
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    el.placeholder = this.dictionary[key];
                } else {
                    el.innerHTML = this.dictionary[key];
                }
            }
        });

        root.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (this.dictionary[key]) {
                el.title = this.dictionary[key];
            }
        });
    },

    /**
     * Atualiza o estado visual das bandeirinhas
     */
    updateActiveUI() {
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-lang') === this.currentLang);
        });
    }
};
