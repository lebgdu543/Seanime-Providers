/// <reference path="./manga-provider.d.ts" />

/**
 * Seanime Manga Provider for Astral-Manga.fr
 *
 * Site: French manga/manhwa scanlation (Next.js RSC-based, Cloudflare-protected)
 *
 * URL structure:
 *   Manga:    /manga/{mangaUuid}
 *   Chapter:  /manga/{mangaUuid}/chapter/{chapterUuid}
 *   Images:   /api/s3/presign-get?key=...
 *   Data:     self.__next_f.push chunks embedded in full HTML page
 *
 * Chapter IDs are encoded as "mangaUuid|chapterUuid" so findChapterPages
 * can reconstruct the URL without an extra lookup.
 */

class Provider {
    api: string;

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

    /** Check if a string looks like a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) */
    isUUID(str: string): boolean {
        return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(str);
    }

    /** Resolve an S3 key (s3:uploads/...) to a presigned URL */
    resolveImage(s3Key: string): string {
        const raw = s3Key.replace(/^s3:/, '');
        return `${this.api}/api/s3/presign-get?key=${encodeURIComponent(raw)}`;
    }

    /**
     * Parse React Server Components wire format from full HTML page.
     *
     * Astral-Manga embeds data as self.__next_f.push([1,"...escaped-json..."]) chunks.
     * We concatenate all chunks, unescape them, and walk the resulting JSON tree.
     */
    parseRSC(html: string): any {
        // Extract all self.__next_f.push([1,"..."]) chunks
        const pushRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
        let combined = '';
        let match;
        while ((match = pushRegex.exec(html)) !== null) {
            combined += match[1]
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
                .replace(/\\n/g, '')
                .replace(/\\t/g, '');
        }

        if (!combined) return null;

        // Try parsing the concatenated JSON
        try {
            const parsed = JSON.parse(combined);
            return this._findMangaInTree(parsed);
        } catch {
            // Fall through to line-based parsing
        }

        // Also try line-based RSC format (0:..., 1:[...], 2:...)
        const lines = html.split('\n');
        for (const line of lines) {
            const colon = line.indexOf(':');
            if (colon <= 0) continue;
            const value = line.substring(colon + 1).trim();
            if (!value.startsWith('{') && !value.startsWith('[')) continue;
            try {
                const parsed = JSON.parse(value);
                const manga = this._findMangaInTree(parsed);
                if (manga) return manga;
            } catch { /* skip */ }
        }

        // Also try concatenated chunks line by line
        const chunkLines = combined.split('\n');
        for (const line of chunkLines) {
            const colon = line.indexOf(':');
            if (colon <= 0) continue;
            const value = line.substring(colon + 1).trim();
            if (!value.startsWith('{') && !value.startsWith('[')) continue;
            try {
                const parsed = JSON.parse(value);
                const manga = this._findMangaInTree(parsed);
                if (manga) return manga;
            } catch { /* skip */ }
        }

        return null;
    }

    /** Recursively search parsed RSC data for a manga or chapter object */
    private _findMangaInTree(node: any, depth: number = 0): any {
        if (!node || typeof node !== 'object' || depth > 20) return null;

        // Manga object: has title + chapters array
        if (node.title && Array.isArray(node.chapters)) return node;

        // Chapter object: has id + images array (with s3: keys)
        if (node.id && Array.isArray(node.images) && node.images.length > 0) {
            const firstImg = node.images[0];
            if (typeof firstImg === 'string' && firstImg.startsWith('s3:')) return node;
            if (firstImg && typeof firstImg === 'object' && (firstImg.key || firstImg.link)) return node;
        }

        // Search result wrapper: { manga: {...} } or { chapter: {...} }
        if (node.manga && typeof node.manga === 'object' && node.manga.title) return node.manga;
        if (node.chapter && typeof node.chapter === 'object' && node.chapter.id) return node.chapter;

        if (Array.isArray(node)) {
            for (const item of node) {
                const found = this._findMangaInTree(item, depth + 1);
                if (found) return found;
            }
        } else if (typeof node === 'object') {
            for (const key of Object.keys(node)) {
                // Skip internal React/Next.js keys
                if (key === 'children' || key === 'props' || key === '_owner' || key === '_store') {
                    const found = this._findMangaInTree(node[key], depth + 1);
                    if (found) return found;
                } else if (!key.startsWith('_') && !key.startsWith('$')) {
                    const found = this._findMangaInTree(node[key], depth + 1);
                    if (found) return found;
                }
            }
        }

        return null;
    }

    /** Raw fetch helper with browser-like headers to pass Cloudflare */
    async _fetch(url: string): Promise<string> {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
                'Cache-Control': 'no-cache',
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    }

    /** Fetch a manga page and extract parsed data */
    async fetchMangaData(mangaId: string): Promise<any> {
        if (!this.isUUID(mangaId)) {
            throw new Error(`Not a UUID: "${mangaId}" — expected Astral UUID, got AniList ID. search() must return Astral UUIDs.`);
        }

        const html = await this._fetch(`${this.api}/manga/${mangaId}`);
        const data = this.parseRSC(html);
        if (!data || !data.title) {
            throw new Error(`Could not extract manga data from page for ${mangaId}`);
        }
        return data;
    }

    // ═══════════════════════════════════════════════════════════
    //  Provider Interface
    // ═══════════════════════════════════════════════════════════

    /**
     * Search for manga on Astral-Manga.
     *
     * Strategy 1: Fetch the search results page and extract manga UUIDs + titles
     *             from self.__next_f.push chunks.
     * Strategy 2: Fallback regex on raw HTML for /manga/{uuid} links.
     *
     * Returns Astral UUIDs so Seanime can map AniList results correctly.
     */
    async search(opts: { query: string }): Promise<MangaSearchResult[]> {
        const q = opts.query.trim();
        if (!q) return [];

        try {
            const searchUrl = `${this.api}/search?q=${encodeURIComponent(q)}`;
            const html = await this._fetch(searchUrl);

            // Strategy 1: Parse RSC chunks for structured results
            const data = this.parseRSC(html);
            if (data) {
                // If parseRSC returned a single manga, wrap it
                if (data.title) {
                    const coverUrl = data.cover?.image?.link
                        ? this.resolveImage(data.cover.image.link)
                        : undefined;
                    return [{
                        id: data.id || '',
                        title: data.title,
                        image: coverUrl,
                    }];
                }

                // If it returned an array
                if (Array.isArray(data)) {
                    return data
                        .filter((item: any) => item && item.title)
                        .map((item: any) => ({
                            id: item.id || '',
                            title: item.title,
                            image: item.cover?.image?.link
                                ? this.resolveImage(item.cover.image.link)
                                : undefined,
                        }));
                }
            }

            // Strategy 2: Regex fallback — extract /manga/{uuid} links from HTML
            const results: MangaSearchResult[] = [];
            const seen = new Set<string>();

            // Match: <a href="/manga/uuid">Title</a> or similar patterns
            const linkRegex = /\/manga\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
            let match;
            while ((match = linkRegex.exec(html)) !== null) {
                const id = match[1];
                if (!seen.has(id)) {
                    seen.add(id);
                    // Try to extract title from surrounding context
                    const contextStart = Math.max(0, match.index - 200);
                    const contextEnd = Math.min(html.length, match.index + 300);
                    const context = html.substring(contextStart, contextEnd);
                    const titleMatch = context.match(/["'>]([^"'{<>}]{3,100})["'<]/);
                    const title = titleMatch ? titleMatch[1].trim() : id;
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
     * Chapters are embedded in the manga page RSC data.
     * Chapter IDs are encoded as "mangaUuid|chapterUuid" for findChapterPages.
     */
    async findChapters(mangaId: string): Promise<MangaChapter[]> {
        try {
            if (!this.isUUID(mangaId)) {
                console.error(
                    `findChapters received non-UUID ID: ${mangaId} — ` +
                    'This is likely an AniList ID. The search() method must return Astral UUIDs.'
                );
                return [];
            }

            const data = await this.fetchMangaData(mangaId);
            const chapters: any[] = data.chapters || [];

            // Sort by orderId descending (newest first)
            const sorted = [...chapters].sort((a, b) => (b.orderId || 0) - (a.orderId || 0));

            return sorted.map((ch, index) => {
                const num = ch.orderId?.toString() || String(index + 1);
                let title = `Chapitre ${num}`;
                if (ch.name && ch.name.trim()) title = ch.name.trim();

                return {
                    id: `${mangaId}|${ch.id}`,       // composite: mangaUuid|chapterUuid
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
     * We fetch the chapter page and extract S3 image keys from the RSC payload,
     * then resolve them to presigned URLs.
     */
    async findChapterPages(chapterId: string): Promise<MangaPage[]> {
        const parts = chapterId.split('|');
        if (parts.length < 2) {
            console.error('Invalid chapterId format, expected "mangaUuid|chapterUuid"');
            return [];
        }
        const mangaUuid = parts[0];
        const chapterUuid = parts[1];
        const chapterUrl = `${this.api}/manga/${mangaUuid}/chapter/${chapterUuid}`;

        try {
            const html = await this._fetch(chapterUrl);

            // Strategy 1: Find S3 keys via regex in raw HTML
            const s3KeyRegex = /s3:uploads\/projects\/[a-f0-9-]{36}\/chapters\/[a-f0-9-]{36}\/[^"'\s,}\]]+/g;
            const s3Keys = html.match(s3KeyRegex) || [];

            if (s3Keys.length > 0) {
                // Filter: keep page images, exclude cover thumbnails
                const pageKeys = s3Keys.filter(k =>
                    !k.includes('/cover') && !k.includes('cover-') && !k.endsWith('-thumb')
                );
                const keys = pageKeys.length > 0 ? pageKeys : s3Keys;
                return keys.map((key, i) => ({
                    url: this.resolveImage(key),
                    index: i,
                    headers: { Referer: `${this.api}/` },
                }));
            }

            // Strategy 2: Parse RSC chunks for chapter object with images
            const chapterData = this.parseRSC(html);
            if (chapterData && Array.isArray(chapterData.images)) {
                return chapterData.images.map((img: any, i: number) => ({
                    url: typeof img === 'string'
                        ? (img.startsWith('s3:') ? this.resolveImage(img) : img)
                        : this.resolveImage(img.key || img.link || img.url || ''),
                    index: i,
                    headers: { Referer: `${this.api}/` },
                }));
            }

            // Strategy 3: If parseRSC returned a wrapped { chapter: {...} }
            if (chapterData && chapterData.chapter && Array.isArray(chapterData.chapter.images)) {
                return chapterData.chapter.images.map((img: any, i: number) => ({
                    url: typeof img === 'string'
                        ? (img.startsWith('s3:') ? this.resolveImage(img) : img)
                        : this.resolveImage(img.key || img.link || img.url || ''),
                    index: i,
                    headers: { Referer: `${this.api}/` },
                }));
            }

            return [];
        } catch (e) {
            console.error('findChapterPages error:', e);
            return [];
        }
    }
}
