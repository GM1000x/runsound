/**
 * api/db.js — Supabase client (singleton)
 * Uses the SERVICE ROLE key so it bypasses RLS.
 * Never expose this key to the frontend.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
}

const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

module.exports = supabase;
