import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ── Inlined shared: CORS ────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Inlined shared: AES-256-GCM encrypt (for silent enrollment) ─
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
async function importEncryptKey(rawB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(rawB64), { name: 'AES-GCM' }, false, ['encrypt']);
}
async function encryptApiKey(plaintext: string, keyVersion = 1) {
  const rawKey = Deno.env.get('API_KEY_ENCRYPTION_KEY');
  if (!rawKey) throw new Error('Missing API_KEY_ENCRYPTION_KEY env var');
  const key = await importEncryptKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv), keyVersion };
}

// ── Types ───────────────────────────────────────────────────────
interface ShopItem {
  item_id: number;
  name: string;
  stock: number;
  buy_price: number;
}
interface Shop {
  category: string;
  items: ShopItem[];
}
interface IngestPayload {
  api_key: string;
  destination: string;
  shops: Shop[];
}

// ── Input validation ────────────────────────────────────────────
function validatePayload(body: unknown): { ok: true; data: IngestPayload } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;

  if (typeof b.api_key !== 'string' || b.api_key.length < 16 || b.api_key.length > 32) {
    return { ok: false, error: 'api_key must be a 16–32 char string' };
  }
  if (typeof b.destination !== 'string' || b.destination.length === 0 || b.destination.length > 50) {
    return { ok: false, error: 'destination must be a non-empty string up to 50 chars' };
  }
  if (!Array.isArray(b.shops) || b.shops.length === 0) {
    return { ok: false, error: 'shops must be a non-empty array' };
  }
  for (const shop of b.shops as unknown[]) {
    if (!shop || typeof shop !== 'object') return { ok: false, error: 'each shop must be an object' };
    const s = shop as Record<string, unknown>;
    if (typeof s.category !== 'string' || s.category.length === 0) {
      return { ok: false, error: 'shop.category must be a non-empty string' };
    }
    if (!Array.isArray(s.items)) return { ok: false, error: 'shop.items must be an array' };
  }
  return { ok: true, data: b as unknown as IngestPayload };
}

// Normalize / accept a single item row. Returns null to skip with reason.
function normalizeItem(item: unknown): ShopItem | { skip: string } {
  if (!item || typeof item !== 'object') return { skip: 'not an object' };
  const i = item as Record<string, unknown>;

  const item_id = Number(i.item_id);
  if (!Number.isInteger(item_id) || item_id <= 0) return { skip: `invalid item_id: ${i.item_id}` };

  const name = typeof i.name === 'string' ? i.name.trim() : '';
  if (!name || name.length > 100) return { skip: `invalid name: ${i.name}` };

  const stock = Number(i.stock);
  if (!Number.isInteger(stock) || stock < 0) return { skip: `invalid stock for ${name}: ${i.stock}` };

  const buy_price = Number(i.buy_price);
  if (!Number.isInteger(buy_price) || buy_price <= 0) return { skip: `invalid buy_price for ${name}: ${i.buy_price}` };

  return { item_id, name, stock, buy_price };
}

// ── Handler ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => null);
    const parsed = validatePayload(body);
    if (!parsed.ok) {
      return new Response(JSON.stringify({ error: parsed.error }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { api_key, destination, shops } = parsed.data;

    // Step 1 — validate the key and resolve player_id via user/basic.
    // Torn's own API tells us whether the key is real and whose it is.
    const tornRes = await fetch(
      `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(api_key)}`,
    );
    const tornData = await tornRes.json();
    if (tornData?.error) {
      return new Response(
        JSON.stringify({ error: `Torn API rejected key: ${tornData.error.error}`, torn_code: tornData.error.code }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const player_id = Number(tornData?.player_id);
    if (!Number.isInteger(player_id) || player_id <= 0) {
      return new Response(JSON.stringify({ error: 'Torn API returned no player_id' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Step 2 — silent enrollment: if no row in player_secrets, create one.
    // Never overwrite: explicit Valigia login via set-api-key always wins.
    const { data: existingSecret } = await supabase
      .from('player_secrets')
      .select('torn_player_id')
      .eq('torn_player_id', player_id)
      .maybeSingle();

    let enrolled = false;
    if (!existingSecret) {
      const { ciphertext, iv, keyVersion } = await encryptApiKey(api_key);
      const { error: insertErr } = await supabase.from('player_secrets').insert({
        torn_player_id: player_id,
        api_key_enc: ciphertext,
        api_key_iv: iv,
        key_version: keyVersion,
        updated_at: new Date().toISOString(),
      });
      // Ignore duplicate-key errors (race condition) — ingest proceeds either way.
      if (insertErr && !insertErr.message.includes('duplicate key')) {
        console.warn(`[ingest] silent enrollment failed: ${insertErr.message}`);
      } else if (!insertErr) {
        enrolled = true;
      }
    }

    // Step 3 — flatten shops into rows, validating each item.
    const rows: Array<{
      item_id: number;
      destination: string;
      item_name: string;
      shop_category: string;
      stock: number;
      buy_price: number;
      observer_player_id: number;
      observed_at: string;
    }> = [];
    const skipped: string[] = [];
    const observed_at = new Date().toISOString();

    for (const shop of shops) {
      for (const raw of shop.items) {
        const norm = normalizeItem(raw);
        if ('skip' in norm) {
          skipped.push(norm.skip);
          continue;
        }
        rows.push({
          item_id: norm.item_id,
          destination,
          item_name: norm.name,
          shop_category: shop.category,
          stock: norm.stock,
          buy_price: norm.buy_price,
          observer_player_id: player_id,
          observed_at,
        });
      }
    }

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: 'No valid items in payload', skipped }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Step 4 — bulk upsert. Conflict on (item_id, destination) → fresh wins.
    const { error: upsertErr } = await supabase
      .from('abroad_prices')
      .upsert(rows, { onConflict: 'item_id,destination' });

    if (upsertErr) {
      return new Response(
        JSON.stringify({ error: `Upsert failed: ${upsertErr.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        destination,
        player_id,
        stored: rows.length,
        skipped: skipped.length,
        skipped_reasons: skipped,
        enrolled,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `ingest-travel-shop error: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
