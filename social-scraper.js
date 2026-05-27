// Content script injected into Instagram, Twitter, etc.

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function scrapeSocials() {
    console.log('[LeadTube Bot] Spider-Web Scraper initialized...');
    
    // Wait for bio to load
    await sleep(3000);
    
    // Read all visible text on the page, ignoring script and style tags
    let cleanText = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walker.nextNode()) {
        const parentName = node.parentNode.nodeName;
        if (parentName !== 'SCRIPT' && parentName !== 'STYLE' && parentName !== 'NOSCRIPT') {
            cleanText += ' ' + node.nodeValue;
        }
    }
    const bodyText = cleanText;
    let emails = extractEmails(bodyText);

    // Filter out false positives common on social media
    emails = emails.filter(e => !e.includes('sentry.io') && !e.includes('instagram.com') && !e.includes('twitter.com'));

    console.log(`[LeadTube Bot] Found ${emails.length} emails on this social profile.`);

    // Tell the background script we are done
    chrome.runtime.sendMessage({
        type: 'SOCIAL_SCRAPE_RESULT',
        payload: {
            emails: emails
        }
    });
}

// Start immediately when the page loads
scrapeSocials();
