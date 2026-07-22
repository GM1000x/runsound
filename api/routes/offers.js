/**
 * api/routes/offers.js — Artist offer management
 *
 * POST /api/offers                     — Create an offer + fund escrow via Stripe
 * GET  /api/offers                     — List artist's offers
 * GET  /api/offers/:id                 — Offer detail + deals
 * POST /api/offers/:id/cancel          — Cancel offer + refund unused escrow
 * GET  /api/offers/:id/invite/:handle  — Creator clicks DM link → redirected to signup/deal
 * POST /api/offers/stripe-webhook      — Stripe confirms payment → activate offer
 */

require('dotenv').config();
const express  = require('express');
const router   = express.Router();
const supabase = require('../db');
const BASE_URL = process.env.BASE_URL || 'https://run-sound.com';

// Lazy Stripe init — avoids crash on startup if key not yet set
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ─── Auth middleware (reuse artist API key) ───────────────────────────────────
async function requireArtist(req, res, next) {
  const auth = req.headers.authorization || '';
  const key  = auth.replace('Bearer ', '').trim();
  if (!key) return res.status(401).json({ ok: false, error: 'Missing API key' });

  const { data: artist } = await supabase
    .from('artists')
    .select('id, artist_name, credits_usd')
    .eq('api_key', key)
    .single();

  if (!artist) return res.status(401).json({ ok: false, error: 'Invalid API key' });
  req.artist = artist;
  next();
}

// ─── POST / — Create offer ────────────────────────────────────────────────────
router.post('/', requireArtist, async (req, res) => {
  const {
    track_name,
    spotify_url,
    tiktok_sound_url,
    payout_per_post_usd,
    max_creators,
    expires_days = 30,
    offer_message
  } = req.body;

  if (!track_name || !spotify_url || !payout_per_post_usd || !max_creators) {
    return res.status(400).json({ ok: false, error: 'track_name, spotify_url, payout_per_post_usd, max_creators required' });
  }

  // Pricing guidance (returned as advisory, not enforced)
  const payout = parseFloat(payout_per_post_usd);
  let pricing_tip = null;
  if (payout < 5)  pricing_tip = 'Tip: Under $5 per post gets very low acceptance rates. We recommend at least $10 for micro-creators.';
  if (payout > 100) pricing_tip = 'Tip: For indie budgets, $10–25 per post across 10–20 micro-creators (under 20k followers) typically outperforms one expensive creator. Higher engagement, more algorithm chances.';

  const budget = parseFloat(payout_per_post_usd) * parseInt(max_creators);
  const expires_at = new Date(Date.now() + expires_days * 86400000).toISOString();

  // Default offer message if not provided
  const message = offer_message || `Hey! I'm ${req.artist.artist_name} — I love your content and think my new track "${track_name}" would be perfect for your style. I'm paying $${payout_per_post_usd} per post when you use my sound. Payment is automatic via RunSound the moment your video goes live. Interested? → ${BASE_URL}/offer-invite`;

  try {
    // Create offer record (unfunded until Stripe confirms)
    const { data: offer, error: offerError } = await supabase
      .from('creator_offers')
      .insert({
        artist_id:          req.artist.id,
        track_name,
        spotify_url,
        tiktok_sound_url:   tiktok_sound_url || null,
        payout_per_post_usd: parseFloat(payout_per_post_usd),
        max_creators:       parseInt(max_creators),
        budget_usd:         budget,
        expires_at,
        offer_message:      message,
        status:             'draft'
      })
      .select()
      .single();

    if (offerError) throw offerError;

    // Create Stripe PaymentIntent for escrow
    const paymentIntent = await getStripe().paymentIntents.create({
      amount:   Math.round(budget * 100), // cents
      currency: 'usd',
      metadata: {
        offer_id:  offer.id,
        artist_id: req.artist.id,
        type:      'creator_escrow'
      },
      description: `RunSound creator escrow: ${track_name} (${max_creators} creators × $${payout_per_post_usd})`,
    });

    // Store PI reference
    await supabase
      .from('creator_offers')
      .update({ stripe_payment_intent_id: paymentIntent.id })
      .eq('id', offer.id);

    res.json({
      ok: true,
      offer_id:             offer.id,
      budget_usd:           budget,
      stripe_client_secret: paymentIntent.client_secret,
      checkout_message:     `Fund $${budget} escrow to activate this offer.`,
      offer_invite_url:     `${BASE_URL}/offer-invite.html?offer=${offer.id}`,
      ...(pricing_tip && { pricing_tip })
    });

  } catch (err) {
    console.error('[offers/create]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET / — List offers ──────────────────────────────────────────────────────
router.get('/', requireArtist, async (req, res) => {
  const { data: offers, error } = await supabase
    .from('creator_offers')
    .select('id, track_name, payout_per_post_usd, max_creators, budget_usd, accepted_count, status, created_at, expires_at, escrow_funded')
    .eq('artist_id', req.artist.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, offers });
});

// ─── GET /:id — Offer detail ──────────────────────────────────────────────────
router.get('/:id', requireArtist, async (req, res) => {
  const { data: offer, error } = await supabase
    .from('creator_offers')
    .select(`
      *,
      creator_deals (
        id, status, accepted_at, tiktok_post_url, post_detected_at,
        payout_usd, paid_at,
        creators ( name, tiktok_handle, email )
      )
    `)
    .eq('id', req.params.id)
    .eq('artist_id', req.artist.id)
    .single();

  if (error || !offer) return res.status(404).json({ ok: false, error: 'Offer not found' });
  res.json({ ok: true, offer });
});

// ─── GET /:id/invite/:handle — Creator lands here from DM ────────────────────
// Creates a deal record and redirects to creator signup with pre-filled context
router.get('/:id/invite/:handle', async (req, res) => {
  const { id: offer_id, handle } = req.params;
  const tiktok_handle = handle.startsWith('@') ? handle : '@' + handle;

  try {
    const { data: offer } = await supabase
      .from('creator_offers')
      .select('id, track_name, payout_per_post_usd, max_creators, accepted_count, status, escrow_funded')
      .eq('id', offer_id)
      .single();

    if (!offer || offer.status !== 'active' || !offer.escrow_funded) {
      return res.redirect(`/creator-signup.html?error=offer_unavailable`);
    }

    if (offer.accepted_count >= offer.max_creators) {
      return res.redirect(`/creator-signup.html?error=offer_full`);
    }

    // Check if creator already exists
    const { data: creator } = await supabase
      .from('creators')
      .select('id, stripe_onboarded')
      .eq('tiktok_handle', tiktok_handle)
      .maybeSingle();

    if (creator) {
      // Ensure deal exists
      await supabase.from('creator_deals').upsert({
        offer_id,
        creator_id:  creator.id,
        status:      'invited',
        payout_usd:  offer.payout_per_post_usd
      }, { onConflict: 'offer_id,creator_id', ignoreDuplicates: true });

      // If already onboarded, send to accept flow
      if (creator.stripe_onboarded) {
        return res.redirect(`/offer-accept.html?offer=${offer_id}&creator=${creator.id}&payout=${offer.payout_per_post_usd}&track=${encodeURIComponent(offer.track_name)}`);
      }
    }

    // New creator — send to signup with offer context
    res.redirect(`/creator-signup.html?offer=${offer_id}&handle=${encodeURIComponent(tiktok_handle)}&payout=${offer.payout_per_post_usd}&track=${encodeURIComponent(offer.track_name)}`);

  } catch (err) {
    console.error('[offers/invite]', err.message);
    res.redirect('/creator-signup.html');
  }
});

// ─── POST /stripe-webhook ─────────────────────────────────────────────────────
// Stripe sends payment_intent.succeeded → fund escrow → activate offer
router.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET_OFFERS);
  } catch (err) {
    console.error('[offers/webhook] Signature failed:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    if (pi.metadata?.type !== 'creator_escrow') return res.json({ received: true });

    const { offer_id } = pi.metadata;

    await supabase
      .from('creator_offers')
      .update({ escrow_funded: true, status: 'active' })
      .eq('id', offer_id);

    console.log(`[offers/webhook] Offer ${offer_id} funded and activated`);
  }

  res.json({ received: true });
});

module.exports = router;
