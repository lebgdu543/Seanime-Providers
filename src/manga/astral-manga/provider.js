/**
 * Seanime Extension for Astral Manga (astral-manga.fr)
 *
 * Astral Manga uses Next.js App Router with React Server Components (RSC).
 * All data comes from the RSC wire format (text/x-component), NOT HTML scraping.
 *
 * URL patterns:
 *   Manga:   https://astral-manga.fr/manga/{urlId}
 *   Chapter: https://astral-manga.fr/manga/{urlId}/chapter/{chapterId}
 *
 * The RSC payload is a multiline JSON format where each line is "key:value".
 * We walk the React element tree to find chapter images and manga metadata.
 *
 * IMPORTANT: Chapter IDs are composite — "urlId/chapterId" — because the
 * Astral URL scheme requires both the manga urlId and the chapter UUID.
 * findChapters encodes them; findChapterPages decodes them.
 */
class Provider {

    constructor() {
        this.api = "https://astral-manga.fr";
    }

    api = "";

    // ─── settings ────────────────────────────────────────────────

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        };
    }

    // ─── RSC helpers ─────────────────────────────────────────────

    /**
     * Fetch a Next.js page as RSC payload.
     * The "RSC: 1" header tells Next.js to return text/x-component.
     */
    async fetchRsc(path) {
        const url = this.api + path;
        const resp = await fetch(url, {
            headers: {
                "RSC": "1",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/x-component",
            },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.text();
    }

    /**
     * Parse the RSC wire format into a flat key→value object.
     * Each line:  "0:{\"b\":\"...\",\"f\":[...]}"
     *             "4:[\"$\",\"main\",null,{...}]"
     */
    parseRsc(text) {
        const lines = text.split("\n");
        const data = {};
        for (const line of lines) {
            const idx = line.indexOf(":");
            if (idx === -1) continue;
            const key = line.substring(0, idx);
            const raw = line.substring(idx + 1);
            if (!raw) continue;
            try {
                data[key] = JSON.parse(raw);
            } catch (_) {
                // "$Sreact.fragment", "I[123,...]" etc. — skip
            }
        }
        return data;
    }

    /**
     * Deep-walk an object tree. Returns the first value matching predicate.
     */
    walkTree(obj, predicate) {
        if (obj === null || obj === undefined || typeof obj !== "object")
            return null;
        if (predicate(obj)) return obj;
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const r = this.walkTree(item, predicate);
                if (r) return r;
            }
        } else {
            for (const key of Object.keys(obj)) {
                const r = this.walkTree(obj[key], predicate);
                if (r) return r;
            }
        }
        return null;
    }

    /**
     * Find the chapter payload: an object with { chapter: { id, images: [...] } }.
     */
    findChapterPayload(rscData) {
        return this.walkTree(
            rscData,
            (v) =>
                v !== null &&
                typeof v === "object" &&
                !Array.isArray(v) &&
                v.chapter !== undefined &&
                v.chapter !== null &&
                typeof v.chapter === "object" &&
                typeof v.chapter.id === "string" &&
                Array.isArray(v.chapter.images)
        );
    }

    /**
     * Find the manga payload: an object with { manga: { id, chapters: [...] } }.
     */
    findMangaPayload(rscData) {
        return this.walkTree(
            rscData,
            (v) =>
                v !== null &&
                typeof v === "object" &&
                !Array.isArray(v) &&
                v.manga !== undefined &&
                v.manga !== null &&
                typeof v.manga === "object" &&
                typeof v.manga.id === "string" &&
                Array.isArray(v.manga.chapters)
        );
    }

    // ─── provider interface ──────────────────────────────────────

    /**
     * Search for manga by title.
     *
     * Tries Astral's search endpoint. Because Seanime already uses AniList for
     * discovery, this just needs to return enough for the user to map entries.
     * Falls back to an empty array if search is unavailable.
     */
    async search(opts) {
        const query = (opts.query || "").trim();
        if (!query) return [];

        // Astral may serve RSC from /search?q=... with the RSC header
        const url = `${this.api}/search?q=${encodeURIComponent(query)}`;

        try {
            const resp = await fetch(url, {
                headers: {
                    "RSC": "1",
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "text/x-component",
                },
            });

            if (!resp.ok) return [];

            const text = await resp.text();
            const data = this.parseRsc(text);

            const results = [];
            const seen = new Set();

            // Walk the tree looking for objects with id+title (manga cards)
            const scan = (obj) => {
                if (!obj || typeof obj !== "object") return;
                if (Array.isArray(obj)) {
                    for (const item of obj) scan(item);
                } else if (typeof obj.id === "string" && typeof obj.title === "string" && obj.id.length > 20) {
                    // Looks like a manga entry (UUID id + title)
                    if (!seen.has(obj.id)) {
                        seen.add(obj.id);
                        results.push({
                            id: obj.urlId || obj.id,
                            title: obj.title,
                            synonyms: undefined,
                            year: obj.publishDate
                                ? new Date(obj.publishDate).getFullYear()
                                : undefined,
                            image: this.resolveImage(obj.cover || obj.coverId),
                        });
                    }
                }
                // Continue deep-scanning
                for (const key of Object.keys(obj)) {
                    scan(obj[key]);
                }
            };
            scan(data);

            return results;
        } catch (_) {
            return [];
        }
    }

    /**
     * Fetch all chapters for a manga.
     *
     * Returns chapters with composite IDs ("urlId/chapterId") so that
     * findChapterPages can reconstruct the full URL.
     */
    async findChapters(mangaId) {
        try {
            const text = await this.fetchRsc(`/manga/${mangaId}`);
            const data = this.parseRsc(text);

            const payload = this.findMangaPayload(data);
            if (!payload || !payload.manga) return [];

            const manga = payload.manga;
            const urlId = manga.urlId || mangaId;

            // Filter out season markers, only keep actual chapters
            const chapters = (manga.chapters || [])
                .filter((ch) => {
                    if (!ch.id) return false;
                    const name = (ch.name || "").toLowerCase();
                    if (name.includes("saison") || name.includes("fin")) return false;
                    return true;
                })
                .map((ch) => ({
                    // Composite ID so findChapterPages can build the URL
                    id: urlId + "/" + ch.id,
                    url: `${this.api}/manga/${urlId}/chapter/${ch.id}`,
                    title: ch.name || `Chapitre ${ch.orderId ?? "?"}`,
                    chapter: String(ch.orderId ?? "?"),
                    index: 0,
                }));

            // Sort by orderId ascending (chapter 1 first)
            chapters.sort(
                (a, b) => parseFloat(a.chapter) - parseFloat(b.chapter)
            );
            chapters.forEach((c, i) => (c.index = i));

            return chapters;
        } catch (e) {
            console.error("[AstralManga] findChapters error:", e);
            return [];
        }
    }

    /**
     * Fetch all page images for a chapter.
     *
     * The chapterId is a composite "urlId/chapterUUID" encoded by findChapters.
     */
    async findChapterPages(chapterId) {
        try {
            // Decode composite ID
            const slashIdx = chapterId.indexOf("/");
            if (slashIdx === -1) {
                console.error(
                    "[AstralManga] Invalid chapter ID (expected urlId/chapterUUID):",
                    chapterId
                );
                return [];
            }

            const urlId = chapterId.substring(0, slashIdx);
            const realChapterId = chapterId.substring(slashIdx + 1);

            const path = `/manga/${urlId}/chapter/${realChapterId}`;
            const text = await this.fetchRsc(path);
            const data = this.parseRsc(text);

            const payload = this.findChapterPayload(data);
            if (!payload || !payload.chapter) return [];

            const images = payload.chapter.images || [];

            return images
                .sort((a, b) => (a.orderId ?? 0) - (b.orderId ?? 0))
                .map((img, i) => ({
                    url: img.link,
                    index: i,
                    headers: {
                        Referer: this.api,
                    },
                }));
        } catch (e) {
            console.error("[AstralManga] findChapterPages error:", e);
            return [];
        }
    }

    // ─── utility ─────────────────────────────────────────────────

    /**
     * Resolve various image reference formats to a usable URL.
     *   "s3:uploads/projects/..."   → wasabi CDN URL
     *   "https://..."               → as-is
     *   "ada8be71-..." (coverId)    → (can't resolve without project UUID)
     */
    resolveImage(ref) {
        if (!ref) return undefined;
        if (ref.startsWith("http")) return ref;
        if (ref.startsWith("s3:")) {
            const path = ref.substring(3);
            return `https://s3.eu-west-2.wasabisys.com/astral-bucket/${path}`;
        }
        // Bare ID — can't resolve to a URL; Seanime will show placeholder
        return undefined;
    }
}
