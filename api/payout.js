/**
 * api/payout.js — Auto-payout when sound-tracker confirms a creator's post
 *
 * Called internally by the sound-tracker skill when a post is detected.
 * Handles Stripe Connect transfer from artist's escrow to creator's account.
 */

require('dotenv').config();
const supabase = require('./db');
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

/**
 * triggerPayout(tiktok_handle, tiktok_post_url)
 *
 * Finds all active accepted deals for this creator handle,
 * confirms the post, and fires Stripe Connect transfers.
 */
async function triggerPayout(tiktok_handle, tiktok_post_url) {
  const handle = tiktok_handle.startsWith('@') ? tiktok_handle : '@' + tiktok_handle;

  console.log(`[payout] Checking deals for ${handle}`);

  // Find creator
  const { data: creator, error: cErr } = await supabase
    .from('creators')
    .select('id, stripe_account_id, stripe_onboarded, name')
    .eq('tiktok_handle', handle)
    .single();

  if (cErr || !creator) {
    console.log(`[payout] No creator found for handle ${handle}`);
    return { paid: 0, skipped: 'no_creator' };
  }

  if (!creator.stripe_onboarded || !creator.stripe_account_id) {
    console.log(`[payout] Creator ${handle} not onboarded on Stripe`);
    return { paid: 0, skipped: 'not_onboarded' };
  }

  // Find all accepted deals for this creator that haven't been paid yet
  const { data: deals, error: dErr } = await supabase
    .from('creator_deals')
    .select('id, payout_usd, offer_id, creator_offers(track_name, stripe_payment_intent_id, status)')
    .eq('creator_id', creator.id)
    .eq('status', 'accepted');

  if (dErr || !deals?.length) {
    console.log(`[payout] No pending accepted deals for ${handle}`);
    return { paid: 0, skipped: 'no_deals' };
  }

  const results = [];

  for (const deal of deals) {
    const offer = deal.creator_offers;

    // Verify offer is still active
    if (offer?.status !== 'active') {
      console.log(`[payout] Offer ${deal.offer_id} not active — skipping`);
      continue;
    }

    try {
      // Mark post detected
      await supabase
        .from('creator_deals')
        .update({
          status:           'posted',
          tiktok_post_url,
          post_detected_at: new Date().toISOString()
        })
        .eq('id', deal.id);

      // Fire Stripe Connect transfer
      const amountCents = Math.round(parseFloat(deal.payout_usd) * 100);

      const transfer = await getStripe().transfers.create({
        amount:      amountCents,
        currency:    'usd',
        destination: creator.stripe_account_id,
        metadata: {
          deal_id:       deal.id,
          offer_id:      deal.offer_id,
          creator_id:    creator.id,
          tiktok_handle: handle,
          track_name:    offer.track_name || '',
          post_url:      tiktok_post_url
        },
        description: `RunSound payout: ${offer.track_name || 'track'} post by ${handle}`
      });

      // Mark paid
      await supabase
        .from('creator_deals')
        .update({
          status:             'paid',
          stripe_transfer_id: transfer.id,
          paid_at:            new Date().toISOString()
        })
        .eq('id', deal.id);

      // Update creator total earned
      await supabase.rpc('increment_creator_earnings', {
        creator_id: creator.id,
        amount:     parseFloat(deal.payout_usd)
      });

      console.log(`[payout] ✅ Paid $${deal.payout_usd} to ${handle} — transfer ${transfer.id}`);
      results.push({ deal_id: deal.id, transfer_id: transfer.id, amount: deal.payout_usd });

    } catch (err) {
      console.error(`[payout] ❌ Failed for deal ${deal.id}:`, err.message);

      await supabase
        .from('creator_deals')
        .update({ status: 'failed' })
        .eq('id', deal.id);

      results.push({ deal_id: deal.id, error: err.message });
    }
  }

  return { paid: results.filter(r => !r.error).length, results };
}

module.exports = { triggerPayout };
