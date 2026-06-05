// Content script injected into YouTube

// Inject a network interceptor to catch emails fetched by other extensions in the background
const interceptScript = document.createElement('script');
interceptScript.textContent = `
    (function() {
        const emailRegex = /([a-zA-Z0-9.+_-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,10})/gi;
        
        function scanAndReport(text) {
            if (typeof text !== 'string') return;
            const matches = text.match(emailRegex);
            if (matches) {
                window.postMessage({ type: 'INTERCEPTED_EMAIL', emails: matches }, '*');
            }
        }

        // Intercept Fetch
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            const response = await originalFetch.apply(this, args);
            try {
                const clone = response.clone();
                clone.text().then(scanAndReport).catch(()=>{});
            } catch(e) {}
            return response;
        };

        // Intercept XHR
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function() {
            this.addEventListener('load', function() {
                try {
                    if (this.responseText) scanAndReport(this.responseText);
                } catch(e) {}
            });
            originalOpen.apply(this, arguments);
        };
    })();
`;
(document.head || document.documentElement).appendChild(interceptScript);

let interceptedEmails = new Set();
window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'INTERCEPTED_EMAIL' && e.data.emails) {
        e.data.emails.forEach(email => {
            const lower = email.toLowerCase();
            if (!lower.includes('youtube.com') && !lower.includes('sentry.io')) {
                interceptedEmails.add(lower);
            }
        });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_SCRAPE') {
        const { id, name } = message.payload;
        console.log(`[LeadTube Bot] Starting scrape for ID: ${id} (${name})`);
        executeWaterfall(id, name);
    }
});

function extractOwnerName(desc, fallbackName) {
    if (!desc) return fallbackName;

    // Remove line breaks to simplify regex matching
    const cleanDesc = desc.replace(/[\r\n]+/g, ' ').trim();

    // 1. High-confidence patterns: Intro followed by CAPITALIZED name (1 to 3 words)
    // The name itself must start with an uppercase letter to prevent matching common lowercase verbs/nouns.
    const capPatterns = [
        /(?:hi|hey|hello|hola)?\s*(?:my name is|i'm|i am|this is)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})/g,
        /(?:created|hosted|run|presented|managed)\s+by\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})/g,
        /\b([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})\s*(?:here|presents|welcomes|shows)\b/g
    ];

    const forbidden = new Set([
        'youtube', 'channel', 'video', 'creator', 'content', 'owner', 'host', 'here', 'welcome', 
        'subscribe', 'follow', 'social', 'media', 'email', 'business', 'contact', 'about', 
        'every', 'daily', 'weekly', 'new', 'free', 'online', 'course', 'learn', 'best', 
        'click', 'link', 'check', 'support', 'help', 'join', 'member', 'please', 'make',
        'google', 'facebook', 'twitter', 'instagram', 'tiktok', 'socials', 'linktree',
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
        'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
        'october', 'november', 'december', 'hey', 'hello', 'hi', 'this', 'that', 'with', 'from',
        'check out', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'the', 'and'
    ]);

    for (const regex of capPatterns) {
        let match;
        regex.lastIndex = 0;
        while ((match = regex.exec(cleanDesc)) !== null) {
            if (match[1]) {
                let candidate = match[1].trim();
                candidate = candidate.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, "").trim();
                const words = candidate.split(/\s+/);
                
                // Ensure name isn't too short or long, and first word isn't a forbidden word
                const firstWordLower = words[0].toLowerCase();
                if (words.length >= 1 && words.length <= 3 && !forbidden.has(firstWordLower) && !words.some(w => forbidden.has(w.toLowerCase()))) {
                    return candidate;
                }
            }
        }
    }

    // 2. Case-insensitive fallback patterns (e.g. lower case names) but requiring 2 words to avoid matching simple single-word verbs/nouns
    const lowerPatterns = [
        /(?:my name is|i'm|i am|this is)\s+([a-zA-Z'-]+\s+[a-zA-Z'-]+)/gi,
        /(?:created|hosted|run|presented|managed)\s+by\s+([a-zA-Z'-]+\s+[a-zA-Z'-]+)/gi
    ];

    for (const regex of lowerPatterns) {
        let match;
        regex.lastIndex = 0;
        while ((match = regex.exec(cleanDesc)) !== null) {
            if (match[1]) {
                let candidate = match[1].trim();
                candidate = candidate.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, "").trim();
                const words = candidate.split(/\s+/);
                const hasForbidden = words.some(w => forbidden.has(w.toLowerCase()));
                if (!hasForbidden && words.length === 2) {
                    // Capitalize it nicely
                    return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                }
            }
        }
    }

    // 3. Fallback to extracting capitalized name from the beginning of the description
    // E.g. "Marques Brownlee is a web creator..."
    const startMatch = cleanDesc.match(/^([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})\b/);
    if (startMatch && startMatch[1]) {
        let candidate = startMatch[1].trim();
        candidate = candidate.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, "").trim();
        const words = candidate.split(/\s+/);
        if (!words.some(w => forbidden.has(w.toLowerCase()))) {
            return candidate;
        }
    }

    return fallbackName;
}

async function fetchLatestVideoTitle(channelUrl) {
    try {
        // Strip query params and hash fragments for robust parsing
        let baseUrl = channelUrl.split('?')[0].split('#')[0];
        let videosUrl = baseUrl
            .replace(/\/about\/?$/, '')
            .replace(/\/featured\/?$/, '')
            .replace(/\/community\/?$/, '')
            .replace(/\/shorts\/?$/, '')
            .replace(/\/$/, '') + '/videos';

        console.log(`[LeadTube Bot] Fetching latest video title from: ${videosUrl}`);
        
        // Do not set User-Agent header as it is forbidden in content scripts and throws TypeErrors
        const response = await fetch(videosUrl, {
            headers: {
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();

        // Strategy 1: Find the first videoId then grab the title that follows it.
        // We use a robust regex to handle escaped double quotes in JSON values: ((?:[^"\\]|\\.)*)
        const videoIdMatch = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
        if (videoIdMatch) {
            const sliceStart = html.indexOf(videoIdMatch[0]);
            const chunk = html.substring(sliceStart, sliceStart + 2000); // look within next 2KB
            const titleMatch = chunk.match(/"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (titleMatch && titleMatch[1]) {
                // Unescape JSON escape sequences
                return titleMatch[1]
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\')
                    .replace(/\\n/g, ' ')
                    .replace(/\\u0026/g, '&')
                    .replace(/\\u003c/g, '<')
                    .replace(/\\u003e/g, '>');
            }
        }

        // Strategy 2: Look for richItemRenderer title pattern (YouTube Shorts-style grid)
        const richMatch = html.match(/"richItemRenderer"[^}]{0,500}"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (richMatch && richMatch[1]) {
            return richMatch[1]
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
                .replace(/\\u0026/g, '&');
        }

    } catch (e) {
        console.error('[LeadTube Bot] Error fetching latest video title:', e);
    }
    return '';
}

async function executeWaterfall(id, channelFallbackName) {
    let emails = [];
    let socials = [];
    let usedCaptcha = false;
    let fullDesc = '';
    let ownerName = channelFallbackName || '';

    // Start fetching latest video title in background immediately
    const lastVideoPromise = fetchLatestVideoTitle(window.location.href);

    // Helper to find emails with robust filtering
    const extractEmails = (text) => {
        if (!text) return [];
        // Extract emails ensuring no trailing non-word characters are captured as TLDs.
        const regex = /(?:^|[^a-zA-Z0-9.+_-])([a-zA-Z0-9.+_-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10})/gi;
        const matches = [...text.matchAll(regex)]
            .map(m => m[1]) // keep original case to detect run-on sentences
            .filter(e => {
                const lower = e.toLowerCase();
                if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.svg') || lower.endsWith('.webp')) return false;
                if (lower.includes('@example.com') || lower.includes('@domain.com') || lower.includes('@email.com') || lower.includes('@yourdomain.com') || lower.includes('sentry.io')) return false;
                if (/^[\._-]/.test(lower)) return false; // Block if starts with punctuation
                return true;
            })
            .map(e => {
                // Fix concatenated sentences like email@gmail.comPlease
                const runOnMatch = e.match(/(.*?(\.com|\.net|\.org|\.co\.uk|\.io|\.co|\.us|\.ca|\.au))([A-Z].*)/);
                if (runOnMatch) {
                    return runOnMatch[1].toLowerCase();
                }
                // Fix lowercase concatenations with common invalid TLD-like suffixes (e.g. .comthanks)
                const lower = e.toLowerCase();
                const invalidSuffixMatch = lower.match(/(.*?(\.com|\.net|\.org))(please|thanks|thankyou|and|for|here)$/);
                if (invalidSuffixMatch) {
                    return invalidSuffixMatch[1];
                }
                return lower;
            });
        return [...new Set(matches)];
    };

    // Helper to sleep
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Helper to construct the final message payload
    const sendScrapeDone = async () => {
        let lastVideoTitle = '';
        try {
            lastVideoTitle = await lastVideoPromise;
        } catch (e) {
            console.error('[LeadTube Bot] Error waiting for last video title:', e);
        }
        chrome.runtime.sendMessage({
            type: 'SCRAPE_DONE',
            payload: {
                id,
                emails,
                socials,
                ownerName,
                description: fullDesc,
                lastVideo: lastVideoTitle,
                usedCaptcha,
                error: null
            }
        });
    };

    // Wait for page to load main elements
    await sleep(2000);

    // Try to click the "...more" or "About" link next to description
    const headerEls = document.querySelectorAll('button, yt-formatted-string, span, div');
    const moreBtn = Array.from(headerEls).find(el => {
        const text = el.textContent.trim().toLowerCase();
        return text === '...more' || text === '... more' || text === 'about' || text === 'more about this channel' || text === 'more';
    });
    
    if (moreBtn) {
        try { moreBtn.click(); } catch(e) {}
        await sleep(2000); // wait for modal to open
    }

    // CRITICAL FIX: YouTube lazy-loads the "View Email" button. We MUST scroll the modal down!
    const scrollers = document.querySelectorAll('tp-yt-paper-dialog, ytd-engagement-panel-section-list-renderer, [id="content"], [id="scroll-target"], #dialog');
    scrollers.forEach(sc => {
        try { sc.scrollTop = sc.scrollHeight + 1000; } catch(e) {}
    });
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1000);

    // --- Scrape Owner Name ---
    try {
        const metaDescEl = document.querySelector('meta[name="description"]');
        fullDesc = metaDescEl ? metaDescEl.content || '' : '';
        
        // Grab from all potential description containers in modern and legacy YouTube channel layouts
        const descContainers = document.querySelectorAll(
            '#description-container, #description, yt-about-channel-renderer, yt-description-preview-view-model, yt-about-channel-renderer-view-model, #description-inline-expander, .ytd-channel-about-metadata-renderer'
        );
        descContainers.forEach(el => {
            if (el.textContent) fullDesc += ' ' + el.textContent;
        });

        // Clean up redundant whitespace in description
        fullDesc = fullDesc.replace(/\s+/g, ' ').trim();

        // Extract channel name directly from the DOM as a high-quality fallback
        let channelNameFromDOM = '';
        const nameEl = document.querySelector('yt-styled-string#channel-name, #channel-name, ytd-channel-name #text, #channel-title-container, title');
        if (nameEl && nameEl.textContent) {
            channelNameFromDOM = nameEl.textContent.replace(/\s*-\s*YouTube/i, '').trim();
        }

        const resolvedFallbackName = channelFallbackName || channelNameFromDOM || '';

        // Run regex extraction
        ownerName = extractOwnerName(fullDesc, resolvedFallbackName);
    } catch(e) {
        console.error('[LeadTube Bot] Error extracting owner name:', e);
    }

    // --- STEP 1: The Easy Grab (Scrape Text and Links) ---
    console.log('[LeadTube Bot] Step 1: Scanning public text and links...');
    
    // Helper to get all text including shadow DOMs, input values, tooltips, and ALL attributes
    const getAllTextAndAttributes = (root) => {
        if (!root) return '';
        let text = '';
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
            const parentName = node.parentNode ? node.parentNode.nodeName : '';
            if (parentName !== 'SCRIPT' && parentName !== 'STYLE' && parentName !== 'NOSCRIPT') {
                text += ' ' + node.nodeValue;
            }
        }
        const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let el of elements) {
            // Check ALL attributes for anything that might contain an email
            if (el.attributes) {
                for (let i = 0; i < el.attributes.length; i++) {
                    const attr = el.attributes[i];
                    if (attr.value && attr.value.includes('@')) {
                        text += ' ' + attr.value;
                    }
                }
            }
            // Check input fields where extensions might place the email
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                text += ' ' + (el.value || '') + ' ' + (el.placeholder || '');
            }
            // Traverse shadow DOMs
            if (el.shadowRoot) {
                text += ' ' + getAllTextAndAttributes(el.shadowRoot);
            }
            // Traverse same-origin iframes
            if (el.tagName === 'IFRAME') {
                try {
                    if (el.contentDocument && el.contentDocument.documentElement) {
                        text += ' ' + getAllTextAndAttributes(el.contentDocument.documentElement);
                    }
                } catch(e) {}
            }
        }
        return text;
    };

    // Poll for up to 12 seconds to give third-party extensions time to load and inject emails
    let emailsFoundAt = -1;
    let allFoundEmails = new Set();

    for (let i = 0; i < 12; i++) {
        let bodyText = getAllTextAndAttributes(document.documentElement);
        // Fallback: Also regex the entire raw HTML string in case the DOM walker missed a hidden extension element
        let rawHtml = document.documentElement.innerHTML || '';
        
        let currentEmails = extractEmails(bodyText + ' ' + rawHtml);

        // Avoid false positives like generic youtube emails
        currentEmails = currentEmails.filter(e => !e.includes('youtube.com') && !e.includes('sentry.io'));
        
        if (currentEmails.length > 0) {
            currentEmails.forEach(e => allFoundEmails.add(e));
            if (emailsFoundAt === -1) emailsFoundAt = i;
        }

        // Also check if our network interceptor caught anything from third-party APIs
        if (interceptedEmails.size > 0) {
            interceptedEmails.forEach(e => allFoundEmails.add(e));
            if (emailsFoundAt === -1) emailsFoundAt = i;
        }

        // Break if we've found emails AND waited at least 3 extra seconds to let other extensions finish loading
        if (emailsFoundAt !== -1 && (i - emailsFoundAt) >= 3) {
            break;
        }
        
        await sleep(1000); // Wait 1s before trying again
    }
    
    // Final collection of intercepted network emails just in case
    interceptedEmails.forEach(e => allFoundEmails.add(e));
    
    emails = Array.from(allFoundEmails);

    // Scrape social links aggressively by checking ALL links on the page
    const linkElements = document.querySelectorAll('a[href]');
    linkElements.forEach(a => {
        const url = a.href.toLowerCase();
        if (url && (url.includes('instagram.com') || url.includes('twitter.com') || url.includes('x.com') || url.includes('facebook.com') || url.includes('tiktok.com'))) {
            // Clean up youtube redirect URLs
            try {
                if (url.includes('redirect?')) {
                    const urlParams = new URLSearchParams(new URL(url).search);
                    const realUrl = urlParams.get('q');
                    if (realUrl) socials.push(realUrl);
                } else {
                    socials.push(a.href); // keep original case
                }
            } catch(e) {}
        }
    });
    socials = [...new Set(socials)];

    // If we found an email, we are DONE! Skip CAPTCHA.
    if (emails.length > 0) {
        console.log('[LeadTube Bot] SUCCESS: Found email in public text! Skipping CAPTCHA.', emails);
        await sendScrapeDone();
        return;
    }

    // --- NEW: Spider-Web Scraper ---
    if (socials.length > 0) {
        console.log('[LeadTube Bot] No email in text, trying Spider-Web Scraper on socials...');
        const socialEmails = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'TRY_SOCIALS',
                payload: { id, socials }
            }, (response) => {
                resolve(response ? response.emails : []);
            });
        });

        if (socialEmails && socialEmails.length > 0) {
            console.log('[LeadTube Bot] SUCCESS: Spider-Web Scraper found emails!', socialEmails);
            emails = socialEmails;
            await sendScrapeDone();
            return;
        }
        console.log('[LeadTube Bot] Spider-Web Scraper found no emails, proceeding to CAPTCHA...');
    }

    // --- STEP 2: The Last Resort (CAPTCHA Button) ---
    console.log('[LeadTube Bot] Step 2: Looking for "View email address" button...');
    
    // Find the button by text (robust search)
    const buttons = Array.from(document.querySelectorAll('button, tp-yt-paper-button, yt-button-shape, a, span, div'));
    // Find the deepest element that contains "view email" but doesn't have too much text
    const emailBtn = buttons.find(b => {
        const text = b.textContent ? b.textContent.toLowerCase().trim() : '';
        return text.includes('view email') && text.length < 30;
    });

    if (emailBtn) {
        usedCaptcha = true;
        console.log('[LeadTube Bot] Clicking View Email button...');
        emailBtn.click();

        await sleep(2000);

        // Check if a CAPTCHA iframe appeared
        const captchaIframe = document.querySelector('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]');
        if (captchaIframe) {
            console.log('[LeadTube Bot] CAPTCHA detected! Pausing and alerting user...');
            chrome.runtime.sendMessage({ type: 'REQUIRE_MANUAL_CAPTCHA' });

            // Poll every 200ms until the email appears (user solved captcha)
            let waitAttempts = 0;
            while (waitAttempts < 1500) { // wait up to 5 minutes
                await sleep(200);
                
                // Check if email link appeared (usually a mailto: link)
                const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
                if (mailtoLinks.length > 0) {
                    emails = [mailtoLinks[0].href.replace('mailto:', '').trim()];
                    console.log('[LeadTube Bot] CAPTCHA Solved! Extracted email:', emails);
                    break;
                }
                waitAttempts++;
            }
        } else {
            // Sometimes it doesn't require a captcha!
            await sleep(2000);
            const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
            if (mailtoLinks.length > 0) {
                emails = [mailtoLinks[0].href.replace('mailto:', '').trim()];
            }
        }
    } else {
        console.log('[LeadTube Bot] No email button found on this channel.');
    }

    // Finish
    await sendScrapeDone();
}
