// Content script injected into Instagram, Twitter, etc.

const extractEmails = (text) => {
    if (!text) return [];
    // Safer regex using matchAll to extract group 1. Ensures it doesn't match filenames like image@2x.png
    const regex = /(?:^|[^a-zA-Z0-9._-])([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
    const matches = [...text.matchAll(regex)]
        .map(m => m[1].toLowerCase())
        .filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.jpeg') && !e.endsWith('.gif') && !e.endsWith('.svg'));
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
