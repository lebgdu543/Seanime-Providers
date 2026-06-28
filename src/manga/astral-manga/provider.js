/// <reference path="./manga-provider.d.ts" />

/**
 * Seanime Manga Provider for Astral-Manga.fr
 *
 * Site: French manga/manhwa scanlation (Next.js App Router)
 *
 * URL structure:
 *   Manga:   /manga/{mangaUuid}
 *   Chapter: /manga/{mangaUuid}/chapter/{chapterUuid}
 *   Images:  /api/s3/presign-get?key=...
 *
 * The site serves Next.js RSC data embedded in self.__next_f.push([1,"..."]) 
 * chunks within the HTML <script> tags. We parse those to extract manga metadata
 * and chapter data. RSC-only requests (?_rsc=..., RSC: 1 header) return 403.
 *
 * Chapter IDs are encoded as "mangaUuid|chapterUuid" so findChapterPages
 * can reconstruct the URL without an extra lookup.
 */

class Provider {
    api;

    constructor() {
        this.api = 'https://astral-manga.fr';
    }

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════

    /** Resolve an S3 key (s3:uploads/...) or direct path to a presigned URL */
    resolveImage(s3Key) {
        const raw = s3Key.replace(/^s3:/, '');
        return `${this.api}/api/s3/presign-get?key=${encodeURIComponent(raw)}`;
    }

    /**
     * Parse React Server Components wire format from HTML.
     *
     * The HTML contains scripts like:
     *   self.__next_f.push([1,"...escaped JSON string..."])
     *
     * We concatenate all chunks, unescape, and walk the resulting tree
     * to find manga/chapter data.
     */
    parseRSC(text) {
        // Extract all __next_f.push([1,"..."]) chunks
        const pushRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
        let combined = '';
        let m;
        while ((m = pushRegex.exec(text)) !== null) {
            combined += m[1]
                .replace(/\\"/g, '"')    // unescape double quotes
                .replace(/\\\\/g, '\\')  // unescape backslashes
                .replace(/\\n/g, '')     // strip newline escapes
                .replace(/\\t/g, '');    // strip tab escapes
        }

        if (!combined) return null;

        // Try parsing the combined string as JSON
        try {
            return JSON.parse(combined);
        } catch {
            // Fallback: try each chunk individually
            const lines = combined.split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    // Check if this line encodes a React tree with manga data
                    if (typeof obj === 'object' && obj !== null) {
                        const found = this._findBySignature(obj);
                        if (found) return found;
                    }
                } catch { /* continue */ }
            }
        }

        return null;
    }

    /**
     * Walk a parsed object tree looking for objects that have
     * the signature fields of manga or chapter data.
     */
    _findBySignature(node, type) {
        if (!node || typeof node !== 'object') return null;

        // Manga signature: has "title" AND "chapters" array
        if (!type || type === 'manga') {
            if (typeof node.title === 'string' && Array.isArray(node.chapters)) {
                return { type: 'manga', data: node };
            }
        }

        // Chapter signature: has "id" AND "images" array (but NOT "chapters")
        if (!type || type === 'chapter') {
            if (typeof node.id === 'string' && Array.isArray(node.images) && !Array.isArray(node.chapters)) {
                return { type: 'chapter', data: node };
            }
        }

        // Recurse
        if (Array.isArray(node)) {
            for (const item of node) {
                const found = this._findBySignature(item, type);
                if (found) return found;
            }
        } else if (typeof node === 'object') {
            for (const key of Object.keys(node)) {
                if (key === '__proto__' || key === 'constructor') continue;
                const found = this._findBySignature(node[key], type);
                if (found) return found;
            }
        }

        return null;
    }

    /** Fetch the manga page HTML and extract RSC data */
    async fetchMangaData(mangaId) {
        const url = `${this.api}/manga/${mangaId}`;

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${mangaId}`);
        }

        const html = await res.text();
        const parsed = this.parseRSC(html);

        if (!parsed) {
            throw new Error(`No RSC data found in HTML for ${mangaId}`);
        }

        // If parseRSC returned the whole tree, search for manga data
        const manga = this._findBySignature(parsed, 'manga');
        if (manga) return manga.data;

        // If parsed result itself is the manga object
        if (parsed.title && Array.isArray(parsed.chapters)) {
            return parsed;
        }

        throw new Error(`No manga data found in RSC for ${mangaId}`);
    }

    /** Fetch chapter page HTML and extract image data */
    async fetchChapterData(mangaId, chapterId) {
        const url = `${this.api}/manga/${mangaId}/chapter/${chapterId}`;

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });

        if (!res.ok) return null;

        const html = await res.text();

        // Strategy 1: Extract S3 keys from the HTML with regex
        const s3KeyRegex = /s3:uploads\/projects\/[a-f0-9-]{36}\/chapters\/[a-f0-9-]{36}\/[^"'\s,}\]]+/g;
        const s3Keys = html.match(s3KeyRegex);
        if (s3Keys && s3Keys.length > 0) {
            // Filter cover thumbnails, keep page images
            const pageKeys = s3Keys.filter(k => !k.includes('/cover') && !k.includes('cover-'));
            return (pageKeys.length > 0 ? pageKeys : s3Keys);
        }

        // Strategy 2: Parse RSC and find chapter object with images array
        const parsed = this.parseRSC(html);
        if (parsed) {
            const chapter = this._findBySignature(parsed, 'chapter');
            if (chapter?.data?.images) {
                return chapter.data.images.map(img => {
                    if (typeof img === 'string') return img;
                    // Image objects: { link: "s3:...", key: "...", url: "..." }
                    return img.link || img.key || img.url || img;
                });
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════
    //  Provider Interface
    // ═══════════════════════════════════════════════════════════

    /**
     * Search for manga by title.
     *
     * Fetches the search page HTML and extracts manga links.
     * If the search returns an exact match, we get the full manga data.
     */
    async search(opts) {
        const q = (opts.query || '').trim();
        if (!q) return [];

        const searchUrl = `${this.api}/search?q=${encodeURIComponent(q)}`;

        try {
            const res = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
                },
            });

            if (!res.ok) return [];

            const html = await res.text();

            // Try RSC parsing first (for exact matches where search redirects to manga page)
            const parsed = this.parseRSC(html);
            if (parsed) {
                const manga = this._findBySignature(parsed, 'manga');
                if (manga?.data) {
                    const d = manga.data;
                    return [{
                        id: d.id || '',
                        title: d.title || '',
                        image: d.cover?.image?.link
                            ? this.resolveImage(d.cover.image.link)
                            : (d.image ? this.resolveImage(d.image) : undefined),
                    }];
                }
                // Check if parsed itself is manga
                if (parsed.title && Array.isArray(parsed.chapters)) {
                    return [{
                        id: parsed.id || '',
                        title: parsed.title,
                        image: parsed.cover?.image?.link
                            ? this.resolveImage(parsed.cover.image.link)
                            : undefined,
                    }];
                }
            }

            // Fallback: extract manga links from search results HTML
            const linkRegex = /\/manga\/([a-f0-9-]{36})[^"]*"[^>]*>([^<]+)</gi;
            const results = [];
            const seen = new Set();
            let match;
            while ((match = linkRegex.exec(html)) !== null) {
                const id = match[1];
                const title = match[2].trim();
                if (!seen.has(id) && title.length > 1) {
                    seen.add(id);
                    results.push({ id, title });
                }
            }
            return results;
        } catch (e) {
            console.error('search error:', e);
            return [];
        }
    }

    /**
     * Get all chapters for a manga.
     *
     * Chapters are extracted from the manga page RSC data.
     * Chapter IDs are encoded as "mangaUuid|chapterUuid" so that
     * findChapterPages can reconstruct the URL directly.
     */
    async findChapters(mangaId) {
        try {
            const data = await this.fetchMangaData(mangaId);
            const chapters = data.chapters || [];

            // Sort by orderId descending (newest first)
            const sorted = [...chapters].sort((a, b) => (b.orderId || 0) - (a.orderId || 0));

            return sorted.map((ch, index) => {
                const num = ch.orderId?.toString() || '0';
                let title = `Chapitre ${num}`;
                if (ch.name && ch.name.trim()) title = ch.name.trim();

                return {
                    id: `${mangaId}|${ch.id}`,
                    url: `${this.api}/manga/${mangaId}/chapter/${ch.id}`,
                    title,
                    chapter: num,
                    index,
                };
            });
        } catch (e) {
            console.error('findChapters error:', e);
            return [];
        }
    }

    /**
     * Get all page images for a chapter.
     *
     * chapterId is the composite "mangaUuid|chapterUuid" from findChapters.
     */
    async findChapterPages(chapterId) {
        const parts = (chapterId || '').split('|');
        if (parts.length < 2) {
            console.error('Invalid chapterId format, expected "mangaUuid|chapterUuid", got:', chapterId);
            return [];
        }
        const mangaUuid = parts[0];
        const chapterUuid = parts[1];
        const chapterUrl = `${this.api}/manga/${mangaUuid}/chapter/${chapterUuid}`;

        try {
            const keys = await this.fetchChapterData(mangaUuid, chapterUuid);
            if (!keys || keys.length === 0) return [];

            return keys.map((key, i) => ({
                url: this.resolveImage(key),
                index: i,
                headers: { Referer: chapterUrl },
            }));
        } catch (e) {
            console.error('findChapterPages error:', e);
            return [];
        }
    }
}
