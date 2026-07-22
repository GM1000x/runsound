/**
 * api/routes/creators.js — Creator marketplace endpoints
 *
 * POST /api/creators/register          — Creator signs up
 * GET  /api/creators/connect-stripe    — Start Stripe Connect onboarding
 * GET  /api/creators/stripe-return     — Stripe redirects back here after onboarding
 * GET  /api/creators/me                — Get creator profile (by email token)
 * GET  /api/creators/deals             — Creator sees their deals + earnings
 * POST /api/creators/deals/:id/accept  — Creator accepts an offer
 */

require('dotenv').config();
const express  = require('express');
const router   = express.Router();
const supabase = require('../db');
const Stripe   = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const BASE_URL = process.env.BASE_URL || 'https://run-sound.com';

// ─── Auth middleware (simple email token in header) ───────────────────────────
async function requireCreator(req, res, next) {
  const token = req.headers['x-creator-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Missing x-creator-token' });

  const { data: creator, error } = await supabase
    .from('creators')
    .select('*')
    .eq('id', token)
    .single();

  if (error || !creator) return res.status(401).json({ ok: false, error: 'Invalid token' });
  req.creator = creator;
  next();
}

// ─── POST /register ───────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { name, email, tiktok_handle } = req.body;

  if (!name || !email || !tiktok_handle) {
    return res.status(400).json({ ok: false, error: 'name, email and tiktok_handle required' });
  }

  // Normalise handle
  const handle = tiktok_handle.startsWith('@') ? tiktok_handle : '@' + tiktok_handle;

  // Check existing
  const { data: existing } = await supabase
    .from('creators')
    .select('id')
    .or(`email.eq.${email},tiktok_handle.eq.${handle}`)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ ok: false, error: 'Email or TikTok handle already registered' });
  }

  const { data: creator, error } = await supabase
    .from('creators')
    .insert({ name, email, tiktok_handle: handle, status: 'pending' })
    .select()
    .single();

  if (error) {
    console.error('[creators/register]', error.message);
    return res.status(500).json({ ok: false, error: 'Failed to register' });
  }

  // creator.id is used as their auth token (simple, replace with JWT later)
  res.json({ ok: true, creator_token: creator.id, creator });
});

// ─── GET /connect-stripe ──────────────────────────────────────────────────────
// Creates a Stripe Express account and returns the onboarding URL
router.get('/connect-stripe', requireCreator, async (req, res) => {
  const creator = req.creator;

  try {
    let accountId = creator.stripe_account_id;

    // Create Express account if not exists
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: creator.email,
        metadata: { creator_id: creator.id, tiktok_handle: creator.tiktok_handle },
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;

      await supabase
        .from('creators')
        .update({ stripe_account_id: accountId })
        .eq('id', creator.id);
    }

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${BASE_URL}/creator-signup.html?stripe=refresh`,
      return_url:  `${BASE_URL}/api/creators/stripe-return?creator_id=${creator.id}`,
      type: 'account_onboarding',
    });

    res.json({ ok: true, onboarding_url: accountLink.url });
  } catch (err) {
    console.error('[creators/connect-stripe]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /stripe-return ───────────────────────────────────────────────────────
// Stripe redirects here after onboarding — verify and mark complete
router.get('/stripe-return', async (req, res) => {
  const { creator_id } = req.query;
  if (!creator_id) return res.redirect('/creator-signup.html?stripe=error');

  try {
    const { data: creator } = await supabase
      .from('creators')
      .select('stripe_account_id')
      .eq('id', creator_id)
      .single();

    if (!creator?.stripe_account_id) return res.redirect('/creator-signup.html?stripe=error');

    const account = await stripe.accounts.retrieve(creator.stripe_account_id);
    const onboarded = account.details_submitted && account.charges_enabled;

    await supabase
      .from('creators')
      .update({ stripe_onboarded: onboarded, status: onboarded ? 'active' : 'pending' })
      .eq('id', creator_id);

    res.redirect(`/creator-signup.html?stripe=${onboarded ? 'success' : 'incomplete'}&creator_id=${creator_id}`);
  } catch (err) {
    console.error('[creators/stripe-return]', err.message);
    res.redirect('/creator-signup.html?stripe=error');
  }
});

// ─── GET /me ──────────────────────────────────────────────────────────────────
router.get('/me', requireCreator, async (req, res) => {
  const { stripe_account_id, ...safe } = req.creator;
  res.json({ ok: true, creator: safe });
});

// ─── GET /deals ───────────────────────────────────────────────────────────────
router.get('/deals', requireCreator, async (req, res) => {
  const { data: deals, error } = await supabase
    .from('creator_deals')
    .select(`
      id, status, accepted_at, tiktok_post_url, post_detected_at,
      payout_usd, paid_at,
      creator_offers ( track_name, spotify_url, payout_per_post_usd, offer_message )
    `)
    .eq('creator_id', req.creator.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, deals });
});

// ─── POST /deals/:id/accept ───────────────────────────────────────────────────
router.post('/deals/:id/accept', requireCreator, async (req, res) => {
  const creator = req.creator;

  if (!creator.stripe_onboarded) {
    return res.status(400).json({ ok: false, error: 'You must complete Stripe onboarding before accepting deals' });
  }

  const { data: deal, error: dealError } = await supabase
    .from('creator_deals')
    .select('*, creator_offers(*)')
    .eq('id', req.params.id)
    .eq('creator_id', creator.id)
    .single();

  if (dealError || !deal) return res.status(404).json({ ok: false, error: 'Deal not found' });
  if (deal.status !== 'invited') return res.status(400).json({ ok: false, error: 'Deal already actioned' });

  const { error } = await supabase
    .from('creator_deals')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .eq('id', deal.id);

  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Increment accepted count on offer
  await supabase.rpc('increment_offer_accepted', { offer_id: deal.offer_id });

  res.json({ ok: true, message: 'Deal accepted — post with the sound and payment releases automatically' });
});

module.exports = router;
