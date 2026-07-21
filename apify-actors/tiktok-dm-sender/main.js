/**
 * RunSound — TikTok DM Sender (Apify Actor)
 *
 * Sends a direct message to a TikTok user via browser automation.
 * Uses the artist's session cookies to authenticate.
 *
 * Input:
 *   sessionCookies  - Array of cookie objects [{name, value, domain, ...}]
 *   targetUsername  - TikTok username to DM (without @)
 *   message         - Message text to send
 *
 * Deploy this to Apify:
 *   1. Go to apify.com → Create Actor
 *   2. Upload this file as main.js
 *   3. Set base image to: apify/actor-node-playwright-chrome
 *   4. Actor name: runsound-tiktok-dm-sender
 *
 * How it works:
 *   - Opens TikTok with the artist's session cookies (they stay logged in)
 *   - Navigates to the creator's profile
 *   - Clicks the Message button
 *   - Types and sends the DM
 *   - Reports success or failure
 */

const { Actor }      = require('apify');
const { chromium }   = require('playwright');

Actor.main(async () => {
  const input = await Actor.getInput();
  const { sessionCookies, targetUsername, message } = input;

  if (!sessionCookies || !targetUsername || !message) {
    throw new Error('Input missing: sessionCookies, targetUsername, and message are required');
  }

  const username = targetUsername.replace('@', '');
  console.log(`[TikTok DM] Sending to @${username}`);

  // Launch stealth browser
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 800 },
    locale:    'en-US',
  });

  // Inject session cookies so we're logged in as the artist
  await context.addCookies(sessionCookies.map(c => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain   || '.tiktok.com',
    path:     c.path     || '/',
    secure:   c.secure   ?? true,
    httpOnly: c.httpOnly ?? false,
    sameSite: c.sameSite || 'None',
  })));

  const page = await context.newPage();

  // Disable automation detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  try {
    // Navigate to creator profile
    const profileUrl = `https://www.tiktok.com/@${username}`;
    console.log(`[TikTok DM] Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for page to load fully
    await page.waitForTimeout(3000);

    // Check if we're logged in
    const isLoggedIn = await page.evaluate(() => {
      return document.cookie.includes('sessionid') ||
             !!document.querySelector('[data-e2e="profile-icon"]') ||
             !!document.querySelector('[data-testid="user-menu"]');
    });

    if (!isLoggedIn) {
      throw new Error('Not logged in — session cookies may be expired');
    }

    // Find the Message button
    // TikTok uses various selectors depending on version
    const messageBtnSelectors = [
      '[data-e2e="message-btn"]',
      'button[aria-label*="Message"]',
      'button[aria-label*="message"]',
      'a[href*="/messages/"]',
      '[data-e2e="send-message"]',
    ];

    let messageBtnClicked = false;
    for (const sel of messageBtnSelectors) {
      try {
        const btn = await page.waitForSelector(sel, { timeout: 5000 });
        if (btn) {
          await btn.click();
          messageBtnClicked = true;
          console.log(`[TikTok DM] Message button clicked (selector: ${sel})`);
          break;
        }
      } catch { /* try next */ }
    }

    if (!messageBtnClicked) {
      // Try finding by text content
      const btns = await page.$$('button');
      for (const btn of btns) {
        const text = await btn.textContent();
        if (text?.toLowerCase().includes('message')) {
          await btn.click();
          messageBtnClicked = true;
          console.log('[TikTok DM] Message button clicked (text match)');
          break;
        }
      }
    }

    if (!messageBtnClicked) {
      throw new Error('Could not find Message button on profile page');
    }

    // Wait for DM dialog / message input
    await page.waitForTimeout(2000);

    const inputSelectors = [
      '[data-e2e="message-input"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="Message"]',
      '[placeholder*="Type a message"]',
    ];

    let inputEl = null;
    for (const sel of inputSelectors) {
      try {
        inputEl = await page.waitForSelector(sel, { timeout: 5000 });
        if (inputEl) {
          console.log(`[TikTok DM] Input found (selector: ${sel})`);
          break;
        }
      } catch { /* try next */ }
    }

    if (!inputEl) {
      throw new Error('Could not find message input field');
    }

    // Type message naturally (human-like delay)
    await inputEl.click();
    await page.waitForTimeout(500);

    // Type character by character with small delays to mimic human
    for (const char of message) {
      await page.keyboard.type(char, { delay: Math.random() * 30 + 20 });
    }

    await page.waitForTimeout(800);

    // Send the message (Enter key or Send button)
    const sendSelectors = [
      '[data-e2e="send-message-btn"]',
      'button[type="submit"]',
      'button[aria-label*="Send"]',
    ];

    let sent = false;
    for (const sel of sendSelectors) {
      try {
        const sendBtn = await page.$(sel);
        if (sendBtn) {
          await sendBtn.click();
          sent = true;
          console.log(`[TikTok DM] Send button clicked`);
          break;
        }
      } catch { /* try next */ }
    }

    if (!sent) {
      // Fallback: press Enter
      await page.keyboard.press('Enter');
      sent = true;
      console.log('[TikTok DM] Sent via Enter key');
    }

    await page.waitForTimeout(2000);

    // Save success output
    await Actor.pushData({
      success:        true,
      target_username: username,
      message_sent:   message,
      sent_at:        new Date().toISOString(),
    });

    console.log(`[TikTok DM] ✅ Successfully sent DM to @${username}`);

  } catch (err) {
    console.error(`[TikTok DM] ❌ Failed for @${username}:`, err.message);

    // Take screenshot for debugging
    try {
      const screenshot = await page.screenshot({ type: 'png' });
      await Actor.setValue('error-screenshot', screenshot, { contentType: 'image/png' });
    } catch { /* ignore */ }

    await Actor.pushData({
      success:         false,
      target_username: username,
      error:           err.message,
      failed_at:       new Date().toISOString(),
    });

    throw err; // Mark actor run as failed

  } finally {
    await browser.close();
  }
});
