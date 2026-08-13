/**
 * Money Hunter — API Server (Express)
 * "Track the note, not the person."
 *
 * Endpoints:
 *   POST /v1/scans           accept a scan (multipart: fields + optional photo)
 *   GET  /v1/notes/:serial   return note summary + full trail
 *   GET  /healthz            liveness probe for Vercel
 *
 * Deploy target: Vercel serverless function (see DEPLOYMENT.md).
 * DB + Storage: Supabase, accessed here with the SERVICE ROLE key so writes
 * bypass RLS — the anon key (used by the client) is read-only per schema.sql.
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 }, // a bit above the ~30KB WebP target, not a hard 30KB wall
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // server-side only — never ship this to the client
);

const SERIAL_REGEX = /^[0-9][A-Z0-9]{2}\s?[0-9]{6}$/;
const PHOTO_BUCKET = "scan-photos";

// ----------------------------------------------------------------------------
// POST /v1/scans
// ----------------------------------------------------------------------------
app.post("/v1/scans", upload.single("photo"), async (req, res) => {
  try {
    const {
      serial_number,
      geohash6,
      city_label,
      scan_source = "citizen",
      device_hash,
      ocr_confidence,
      liveness_ok,
    } = req.body;

    if (!serial_number || !SERIAL_REGEX.test(serial_number)) {
      return res.status(400).json({ error: "invalid_serial_format" });
    }
    if (!geohash6 || !/^[0-9bcdefghjkmnpqrstuvwxyz]{6}$/.test(geohash6)) {
      return res.status(400).json({ error: "invalid_geohash" });
    }

    // 1. Find-or-create the note row.
    let { data: note, error: noteErr } = await supabase
      .from("notes")
      .select("note_id, scan_count")
      .eq("serial_number", serial_number)
      .maybeSingle();

    if (noteErr) throw noteErr;

    if (!note) {
      const { data: created, error: createErr } = await supabase
        .from("notes")
        .insert({ serial_number })
        .select("note_id, scan_count")
        .single();
      if (createErr) throw createErr;
      note = created;
    }

    const isFirstScan = note.scan_count === 0;

    // 2. Upload the compressed photo proof to Object Storage, if provided.
    // Storage optimization: only the URL is ever written to the scans row —
    // the binary never touches the database.
    let photo_url = null;
    if (req.file) {
      const path = `${note.note_id}/${Date.now()}.webp`;
      const { error: uploadErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(path, req.file.buffer, { contentType: "image/webp", upsert: false });
      if (uploadErr) throw uploadErr;

      const { data: publicUrl } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
      photo_url = publicUrl.publicUrl;
    }

    // 3. Insert the scan. The UNIQUE(note_id, scan_date) constraint is the
    // real throttle enforcement — this is a defense-in-depth check so we can
    // return a friendly "already scanned today" response instead of a raw
    // constraint-violation error.
    const today = new Date().toISOString().slice(0, 10);
    const { data: existingToday } = await supabase
      .from("scans")
      .select("scan_id, scanned_at, geohash6, city_label, photo_url")
      .eq("note_id", note.note_id)
      .eq("scan_date", today)
      .maybeSingle();

    let scanRow = existingToday;
    let duplicateToday = false;

    if (existingToday) {
      duplicateToday = true; // graceful UX: no new row, no storage cost, but not an error
    } else {
      const { data: inserted, error: insertErr } = await supabase
        .from("scans")
        .insert({
          note_id: note.note_id,
          geohash6,
          city_label: city_label ?? null,
          scan_source,
          device_hash: device_hash ?? null,
          photo_url,
          liveness_ok: liveness_ok === "false" ? false : liveness_ok === false ? false : true,
          scan_date: today,
        })
        .select()
        .single();

      // A concurrent request racing us to the same (note_id, scan_date) pair
      // hits the unique constraint here rather than the pre-check above —
      // treat that the same way as a graceful duplicate, not a 500.
      if (insertErr && insertErr.code === "23505") {
        duplicateToday = true;
        const { data: raceLoser } = await supabase
          .from("scans")
          .select("scan_id, scanned_at, geohash6, city_label, photo_url")
          .eq("note_id", note.note_id)
          .eq("scan_date", today)
          .maybeSingle();
        scanRow = raceLoser;
      } else if (insertErr) {
        throw insertErr;
      } else {
        scanRow = inserted;
      }
    }

    // 4. Return the full trail so the client can render the reveal screen
    // without a second round trip.
    const trail = await fetchTrail(note.note_id);

    return res.status(duplicateToday ? 200 : 201).json({
      status: isFirstScan ? "first" : "repeat",
      duplicate_today: duplicateToday,
      note_id: note.note_id,
      serial_number,
      scan: scanRow,
      trail,
    });
  } catch (err) {
    console.error("POST /v1/scans failed:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ----------------------------------------------------------------------------
// GET /v1/notes/:serial — summary + trail for a serial number
// ----------------------------------------------------------------------------
app.get("/v1/notes/:serial", async (req, res) => {
  const serial = decodeURIComponent(req.params.serial).toUpperCase();
  if (!SERIAL_REGEX.test(serial)) {
    return res.status(400).json({ error: "invalid_serial_format" });
  }

  const { data: note, error } = await supabase
    .from("notes")
    .select("note_id, serial_number, denom, series, first_seen_at, scan_count, flagged")
    .eq("serial_number", serial)
    .maybeSingle();

  if (error) return res.status(500).json({ error: "internal_error" });
  if (!note) return res.status(404).json({ error: "not_found" });

  const trail = await fetchTrail(note.note_id);
  return res.json({ ...note, trail });
});

async function fetchTrail(noteId) {
  const { data, error } = await supabase
    .from("scans")
    .select("scan_id, scanned_at, geohash6, city_label, scan_source, photo_url, liveness_ok")
    .eq("note_id", noteId)
    .order("scanned_at", { ascending: true });
  if (error) throw error;
  return data;
}

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Local dev entrypoint; Vercel wraps `app` as a serverless function instead
// of calling listen() — see DEPLOYMENT.md.
if (process.env.NODE_ENV !== "production" || process.env.LOCAL_DEV === "1") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Money Hunter API listening on :${port}`));
}

export default app;
