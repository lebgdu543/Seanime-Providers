/// <reference path="./manga-provider.d.ts" />

class Provider {

    constructor() {
        this.base = "https://astral-manga.fr"
    }

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        }
    }

    _headers(referer) {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            "Referer": referer || (this.base + "/"),
        }
    }

    // ── SEARCH ──────────────────────────────────────────────

    async search(opts) {
        try {
            var query = (opts && opts.query) ? opts.query.trim() : ""
            if (!query) return []

            var url = this.base + "/search?q=" + encodeURIComponent(query)
            var html = await this._fetch(url)

            // Strategy 1: Extract UUIDs from Next.js RSC chunks in the HTML
            var results = this._parseSearchFromRSC(html)
            if (results.length > 0) return results

            // Strategy 2: Fallback regex on visible HTML
            return this._parseSearchFromHTML(html)
        } catch (e) {
            return []
        }
    }

    _parseSearchFromRSC(html) {
        var results = []
        var seen = {}

        // The HTML page embeds self.__next_f.push chunks with RSC payloads
        // Each manga card shows as: /manga/<UUID>
        var chunkRe = /self\.__next_f\.push\(\[1,"([^"]*\\/manga\\/[a-f0-9-]{36}[^"]*)"\]\)/g
        var m
        while ((m = chunkRe.exec(html)) !== null) {
            var raw = m[1]
            // Extract UUID
            var uuidM = raw.match(/\/([a-f0-9-]{36})/)
            if (!uuidM) continue
            var uuid = uuidM[1]
            if (seen[uuid]) continue
            seen[uuid] = true

            // Try to get title from the payload
            var title = this._titleFromPayload(m[0]) || "Unknown"

            results.push({
                id: uuid,
                title: title,
                image: "",
                synonyms: [],
            })
        }
        return results
    }

    _parseSearchFromHTML(html) {
        var results = []
        var seen = {}

        // Direct link regex fallback
        var linkRe = /href="\/manga\/([a-f0-9-]{36})"/g
        var m
        while ((m = linkRe.exec(html)) !== null) {
            var uuid = m[1]
            if (seen[uuid]) continue
            seen[uuid] = true

            // Try to find nearby title
            var nearby = html.slice(Math.max(0, m.index - 300), m.index + 500)
            var titleM = nearby.match(/(?:alt|title)="([^"]{2,100})"/)
            var title = titleM ? titleM[1].trim() : uuid.slice(0, 8)

            results.push({
                id: uuid,
                title: title,
                image: "",
                synonyms: [],
            })
        }
        return results
    }

    _titleFromPayload(chunk) {
        // Try to extract title from the JSON payload
        var m = chunk.match(/\\"title\\":\\"([^"\\]{2,200})\\"/)
        if (m) return m[1]
        m = chunk.match(/\\"name\\":\\"([^"\\]{2,200})\\"/)
        if (m) return m[1]
        return null
    }

    // ── CHAPTERS ────────────────────────────────────────────

    async findChapters(seriesId) {
        try {
            var url = this.base + "/manga/" + seriesId
            var html = await this._fetch(url)

            // Extract chapters from self.__next_f.push RSC chunks
            var chapters = []
            var seen = {}

            // Chapter entries look like:
            // /manga/<uuid>/<chapter-number> or contain chapter numbers in payload
            var chRe = /"\/manga\/[a-f0-9-]{36}\/(\d+(?:\.\d+)?)"/g
            var m
            while ((m = chRe.exec(html)) !== null) {
                var chNum = m[1]
                if (seen[chNum]) continue
                seen[chNum] = true

                chapters.push({
                    id: seriesId + "/" + chNum,
                    url: this.base + "/manga/" + seriesId + "/" + chNum,
                    title: "Chapitre " + chNum,
                    chapter: chNum,
                    index: 0,
                })
            }

            // If no matches, try RSC chunk approach
            if (chapters.length === 0) {
                chapters = this._parseChaptersFromRSC(html, seriesId)
            }

            // Sort by chapter number descending (newest first), then set index
            chapters.sort(function(a, b) {
                return parseFloat(b.chapter) - parseFloat(a.chapter)
            })
            for (var i = 0; i < chapters.length; i++) {
                chapters[i].index = i
            }

            return chapters
        } catch (e) {
            return []
        }
    }

    _parseChaptersFromRSC(html, seriesId) {
        var chapters = []
        var seen = {}

        // Extract all Next.js RSC chunks
        var chunks = []
        var chunkRe = /self\.__next_f\.push\(\[1,"([^"]+)"\]\)/g
        var m
        while ((m = chunkRe.exec(html)) !== null) {
            chunks.push(m[1])
        }

        var fullPayload = chunks.join("")

        // Chapter pattern in RSC: /manga/<uuid>/<num>
        var chRe = new RegExp("\\\\/manga\\\\/" + seriesId + "\\\\/(\\\\d+(?:\\\\.\\\\d+)?)", "g")
        while ((m = chRe.exec(fullPayload)) !== null) {
            var chNum = m[1].replace(/\\/g, "")
            if (seen[chNum]) continue
            seen[chNum] = true

            chapters.push({
                id: seriesId + "/" + chNum,
                url: this.base + "/manga/" + seriesId + "/" + chNum,
                title: "Chapitre " + chNum,
                chapter: chNum,
                index: 0,
            })
        }
        return chapters
    }

    // ── PAGES ───────────────────────────────────────────────

    async findChapterPages(chapterId) {
        try {
            // chapterId format: "<seriesUUID>/<chapterNumber>"
            var parts = chapterId.split("/")
            var seriesUUID = parts[0]
            var chapterNum = parts[1] || parts[0]

            var url = this.base + "/manga/" + seriesUUID + "/" + chapterNum
            var html = await this._fetch(url)

            // Strategy 1: Regex for S3 presigned URLs (uploads/... pattern)
            var pages = this._parseImagesRegex(html)
            if (pages.length > 0) return pages

            // Strategy 2: Walk RSC chunks for image arrays
            return this._parseImagesFromRSC(html)
        } catch (e) {
            return []
        }
    }

    _parseImagesRegex(html) {
        var pages = []
        var seen = {}

        // Common patterns:
        // s3:uploads/... keys that resolve to presigned URLs
        // Direct presigned URLs
        var imgRe = /https?:\/\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp|avif)[^"'\s<>]*/gi
        var m
        var idx = 0

        while ((m = imgRe.exec(html)) !== null) {
            var imgUrl = m[0]
            if (seen[imgUrl]) continue
            // Skip icons/logos
            if (/\/favicon\.|\/icon\.|\/logo\.|\/avatar\.|\/banner\.|google|facebook|twitter|cloudflare/i.test(imgUrl)) continue
            if (imgUrl.length > 500) continue
            seen[imgUrl] = true

            pages.push({
                url: imgUrl,
                index: idx++,
                headers: { "Referer": this.base + "/" },
            })
        }
        return pages
    }

    _parseImagesFromRSC(html) {
        var pages = []
        var seen = {}

        // Collect all RSC chunks
        var chunks = []
        var chunkRe = /self\.__next_f\.push\(\[1,"([^"]+)"\]\)/g
        var m
        while ((m = chunkRe.exec(html)) !== null) {
            chunks.push(m[1])
        }

        var fullPayload = chunks.join("")

        // Look for image arrays: "images":[{"key":"uploads/...",...}]
        // or direct URLs in the payload
        var imgRe = /https?:\\\/\\\/[^"\\]+\.(?:jpg|jpeg|png|webp|avif)[^"\\]*/gi
        while ((m = imgRe.exec(fullPayload)) !== null) {
            var imgUrl = m[0].replace(/\\\//g, "/")
            if (seen[imgUrl]) continue
            if (/\/favicon\.|\/icon\.|\/logo\.|\/avatar\.|\/banner\.|google|facebook|twitter|cloudflare/i.test(imgUrl)) continue
            if (imgUrl.length > 500) continue
            seen[imgUrl] = true

            pages.push({
                url: imgUrl,
                index: pages.length,
                headers: { "Referer": this.base + "/" },
            })
        }
        return pages
    }

    // ── HELPERS ─────────────────────────────────────────────

    async _fetch(url) {
        var res = await fetch(url, {
            headers: this._headers(url),
            redirect: "follow",
        })
        return await res.text()
    }
}
