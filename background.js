// Keeps track of active scraping tabs
const activeScrapes = new Map(); // tabId -> payload

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 1. Dashboard requested a scrape
    if (message.type === 'BG_COMMAND_SCRAPE') {
        const { id, name, url, delayMs } = message.payload;
        
        let targetUrl = url.trim();
        if (!/^https?:\/\//i.test(targetUrl)) {
            targetUrl = 'https://' + targetUrl;
        }

        // Create a tiny floating popup window for the scraping.
        // Starts with focused: false so it doesn't interrupt, and flashes in the taskbar when needed.
        chrome.windows.create({
            url: targetUrl,
            type: 'popup',
            width: 800,
            height: 600,
            focused: true 
        }, (window) => {
            const tabId = window.tabs[0].id;
            activeScrapes.set(tabId, { id, name, url: targetUrl, windowId: window.id });
        });
    }

    // 2. YouTube scraper finished
    if (message.type === 'SCRAPE_DONE') {
        const tabId = sender.tab.id;
        
        // Forward result to dashboard unconditionally (Broadcast to all tabs, dashboard-bridge will pick it up)
        chrome.tabs.query({}, (tabs) => {
            for (const t of tabs) {
                chrome.tabs.sendMessage(t.id, {
                    type: 'BG_SCRAPE_RESULT',
                    payload: message.payload
                }).catch(() => {}); // ignore errors for tabs without our listener
            }
        });

        // Clean up: close the popup window using the sender's windowId
        if (sender.tab && sender.tab.windowId) {
            chrome.windows.remove(sender.tab.windowId).catch(()=>{});
        } else {
            chrome.tabs.remove(tabId).catch(()=>{});
        }
        
        activeScrapes.delete(tabId);
    }

    // 3. YouTube scraper requires manual CAPTCHA solving
    if (message.type === 'REQUIRE_MANUAL_CAPTCHA') {
        const tabId = sender.tab.id;
        const scrapeInfo = activeScrapes.get(tabId);
        
        // Try to focus the popup (Windows will flash it in the taskbar)
        if (scrapeInfo && scrapeInfo.windowId) {
            chrome.windows.update(scrapeInfo.windowId, { focused: true });
        } else {
            chrome.windows.update(sender.tab.windowId, { focused: true });
        }
        chrome.tabs.update(tabId, { active: true });
    }

    // 4. Spider-Web Scraper Coordination
    if (message.type === 'TRY_SOCIALS') {
        const { socials } = message.payload;
        
        // We will only check the first high-value social link to save time (Instagram or Twitter)
        const bestLink = socials.find(s => s.includes('instagram.com') || s.includes('twitter.com') || s.includes('x.com'));
        
        if (bestLink) {
            chrome.tabs.create({ url: bestLink, active: false }, (socialTab) => {
                // Store the callback
                activeScrapes.set(socialTab.id, { isSocial: true, sendResponse });
                
                // Set a timeout in case it hangs
                setTimeout(() => {
                    if (activeScrapes.has(socialTab.id)) {
                        chrome.tabs.remove(socialTab.id).catch(()=>{});
                        activeScrapes.delete(socialTab.id);
                        sendResponse({ emails: [] });
                    }
                }, 8000);
            });
            return true; // Keep message channel open for async response
        } else {
            sendResponse({ emails: [] });
        }
    }

    if (message.type === 'SOCIAL_SCRAPE_RESULT') {
        const tabId = sender.tab.id;
        const info = activeScrapes.get(tabId);
        if (info && info.isSocial) {
            info.sendResponse({ emails: message.payload.emails });
            chrome.tabs.remove(tabId).catch(()=>{});
            activeScrapes.delete(tabId);
        }
    }
});

// Watch for tab loading completion
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && activeScrapes.has(tabId)) {
        const scrapeInfo = activeScrapes.get(tabId);
        
        // Give the page a short moment to render dynamic content
        setTimeout(() => {
            chrome.tabs.sendMessage(tabId, {
                type: 'START_SCRAPE',
                payload: scrapeInfo
            }).catch(e => console.log('Error sending to tab', e));
        }, 2000);
    }
});
