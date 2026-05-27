// This script runs on the Extractor Dashboard
// It bridges communication between the webpage (app.js) and the extension background worker.

// Only activate if we are on the Dashboard
if (document.title.includes('Email Extractor | LeadTube Addon')) {
    console.log('[LeadTube Bot] Dashboard detected. Initializing bridge...');

    // Tell the dashboard we are ready
    window.postMessage({ type: 'EXT_READY' }, '*');

    // Listen for messages from the Dashboard (app.js)
    window.addEventListener('message', (event) => {
        // We only accept messages from ourselves
        if (event.source !== window) return;

        if (event.data.type === 'APP_PING') {
            window.postMessage({ type: 'EXT_PONG' }, '*');
        }

        if (event.data.type === 'APP_COMMAND_SCRAPE') {
            console.log('[LeadTube Bot] Forwarding scrape command to background...');
            // Forward to background.js
            chrome.runtime.sendMessage({
                type: 'BG_COMMAND_SCRAPE',
                payload: event.data.payload
            });
        }
    });

    // Listen for messages from background.js and forward to Dashboard
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'BG_SCRAPE_RESULT') {
            window.postMessage({
                type: 'EXT_SCRAPE_RESULT',
                payload: message.payload
            }, '*');
        }
    });
}
