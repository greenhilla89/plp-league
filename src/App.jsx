import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Trophy, Lock, Unlock, CheckCircle2, Clock, Plus, Send,
  AlertCircle, Users, BarChart3, Settings2, X, Crown, Medal,
  Eye, EyeOff, ShieldCheck, Loader2, Trash2, Calendar, Sparkles,
  UserCircle2, Camera, MapPin, Cake, Shirt, Mail, KeyRound, LogOut,
  TrendingUp, ArrowLeft, Target, Flame, Award, Archive, History, Landmark,
  Upload, Share2,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

// The site mark — the official PLP logo (public/plp-logo.png), presented
// on a white rounded card baked into the image itself, so the purple globe
// reads clearly everywhere: on light pages and on the dark purple banner
// alike. Callers size it with className exactly as before.
function Logo({ className }) {
  return <img src="/plp-logo.png" alt="PLP" className={className} />;
}

/* ============================================================================
   PLP 2026-27 — multi-division football prediction game

   Originally built as a Claude artifact; now a standalone site backed by a
   Supabase database (see storageAdapter.js). The storage interface is
   unchanged, so everything below reads and writes exactly as it always did.

   DATA MODEL (persisted via window.storage, shared across everyone who
   opens this site — see footer note):

   {
     adminPin: string,                 // lightweight shared gate, NOT real auth
     leagues: {
       league1: { name, participants: [{id,name}], matchdays: [MatchDay] },
       league2: { name, participants: [{id,name}], matchdays: [MatchDay] },
     },
     predictions: {
       "<matchId>__<participantId>": { home: number, away: number, submittedAt }
     }
   }

   MatchDay = {
     id, label,
     releaseAt: ISO string | null,   // when OTHER people's picks become visible
     locked: boolean,                // predictions closed (e.g. at kickoff)
     scoring: { resultPoints, homeGoalPoints, awayGoalPoints, marginPoints },
     matches: [{ id, home, away, kickoff: ISO string, outcome: {home,away}|null }]
   }

   SCORING — four independent components per match, each checked against the
   entered outcome:
     resultPoints     (default 3) — predicted result (home win / away win /
                        draw) matches the actual result.
     homeGoalPoints   (default 1) — predicted home team's goals exactly.
     awayGoalPoints   (default 1) — predicted away team's goals exactly.
     marginPoints     (default 1) — predicted goal difference (home − away)
                        exactly matches the actual goal difference. Since a
                        matching difference always implies the same result,
                        this point only ever lands alongside resultPoints.
   Maximum per match = 3 + 1 + 1 + 1 = 6, earned in full only for an exact
   scoreline.
   ========================================================================== */

const STORAGE_KEY = "forecast-room-state-v2"; // legacy single-blob key — only ever read once, to migrate old saves
const SNAPSHOTS_KEY = "plp-2026-27-snapshots-v1"; // rotating automatic backups, stored separately so they don't nest inside themselves
// Everything used to live in one blob under STORAGE_KEY. Splitting it means:
// (a) no single key grows unboundedly as photos/predictions/history
//     accumulate over a season, and (b) a photo upload, a fixture edit, and
//     a prediction submission no longer all fight over the exact same key at
//     once — each only touches its own slice.
const CORE_KEY = "plp-2026-27-core-v1"; // admin PIN, export timestamp, league names/matchdays/fixture pools/scoring
const ACCOUNTS_KEY = "plp-2026-27-accounts-v1"; // email/salt/hash/participant links
const ROSTER_KEY = "plp-2026-27-roster-v1"; // participant names/codes/bios/etc — everything except photos
const PHOTOS_KEY = "plp-2026-27-photos-v1"; // profile photos only, kept separate since they're the biggest payloads
const BADGES_KEY = "plp-2026-27-badges-v1"; // admin-assigned team-crest badges — separate from self-uploaded profile photos
const HISTORY_KEY = "plp-2026-27-history-page-v1"; // the free-text History page + its images, isolated since images can be large
const PREDICTIONS_KEY = "plp-2026-27-predictions-v1"; // the highest-frequency write in the app, isolated on its own
const SEASON_ARCHIVES_KEY = "plp-2026-27-season-archives-v1"; // past seasons — grows slowly but can get large, so it's isolated too
const DEFAULT_MAX_PARTICIPANTS = 20; // fallback cap when a league doesn't specify its own
const DEFAULT_MIN_PARTICIPANTS = 2; // fallback floor when a league doesn't specify its own — the lowest a round-robin schedule needs
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000; // take a new automatic snapshot at most once per 24h
const MAX_SNAPSHOTS = 7; // keep a rolling week of daily snapshots
const EXPORT_REMINDER_MS = 72 * 60 * 60 * 1000; // nudge admin to download a manual backup every 72h

// The four possible division "slots" this app supports. Not every slot has
// to be used — each league also carries its own `enabled` flag (see
// DivisionsCard) — but the key/default name/default cap are fixed here so
// the rest of the app has a stable, ordered list to iterate over. Premier
// League is always enabled and can't be turned off; the others are
// optional and their participant cap is admin-editable (Championship
// defaults to 24 since that was specified as its ceiling, but any of
// these can be changed).
const LEAGUE_DEFS = [
  { key: "league1", defaultName: "PLP Premier League", defaultMaxParticipants: 20, defaultMinParticipants: 4, alwaysEnabled: true, accent: "#FBBF24" },
  { key: "league2", defaultName: "PLP Championship", defaultMaxParticipants: 24, defaultMinParticipants: 2, alwaysEnabled: false, accent: "#38BDF8" },
  { key: "league3", defaultName: "PLP League One", defaultMaxParticipants: 24, defaultMinParticipants: 2, alwaysEnabled: false, accent: "#34D399" },
  { key: "league4", defaultName: "PLP League Two", defaultMaxParticipants: 24, defaultMinParticipants: 2, alwaysEnabled: false, accent: "#FB7185" },
];

// Each division's signature colour — Premier League keeps the site's amber;
// Championship sky blue, League One green, League Two rose — used on the
// division switcher, the banner's accent strip, and the tab underlines, so
// each division feels like its own competition.
function leagueAccent(key) {
  return LEAGUE_DEFS.find((d) => d.key === key)?.accent ?? "#FBBF24";
}

function enabledLeagueKeys(data) {
  return LEAGUE_DEFS.map((d) => d.key).filter((key) => data.leagues[key]?.enabled);
}

function emptyLeagueSlot(name, maxParticipants, minParticipants) {
  return {
    name,
    enabled: false,
    maxParticipants,
    minParticipants: minParticipants ?? DEFAULT_MIN_PARTICIPANTS,
    h2hSchedule: [],
    participants: [],
    matchdays: [],
    fixturePool: [],
    adjustments: [],
  };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------
function seedData() {
  const league1ParticipantIds = ["l1p1", "l1p2", "l1p3", "l1p4", "l1p5", "l1p6"];
  const league2ParticipantIds = ["l2p1", "l2p2", "l2p3", "l2p4", "l2p5"];
  const league1Schedule = generateRoundRobinSchedule(league1ParticipantIds);
  const league2Schedule = generateRoundRobinSchedule(league2ParticipantIds);

  return {
  adminPin: "2210",
  lastManualExportAt: null,
  seasonLabel: "2026-27",
  seasonArchives: [], // past seasons, archived in full when the admin ends one — see endSeason() below
  legacyHonours: [], // manually-entered honours from before this app existed — see HonoursView below
  historyPage: {
    text: "The story of this competition starts here — Admin can write the full history in Admin > History and add photos alongside it.",
    images: [],
  },
  accounts: {}, // keyed by lowercased email — see hashPassword()/randomSaltHex() below
  leagues: {
    league1: {
      name: "PLP Premier League",
      enabled: true,
      maxParticipants: 20,
      minParticipants: 4,
      h2hSchedule: league1Schedule,
      participants: [
        { id: "l1p1", name: "Amara", code: randomInviteCode() },
        { id: "l1p2", name: "Kenji", code: randomInviteCode() },
        { id: "l1p3", name: "Priya", code: randomInviteCode() },
        { id: "l1p4", name: "Lucas", code: randomInviteCode() },
        { id: "l1p5", name: "Nadia", code: randomInviteCode() },
        { id: "l1p6", name: "Oskar", code: randomInviteCode() },
      ],
      matchdays: [
        {
          id: "l1md1",
          label: "Matchday 1",
          blog: "What a matchday to kick things off! Northgate United came out swinging, Millbrook and Sterling played out a cagey stalemate, and Copper Vale ran riot at Hartley Town. Plenty of upsets in the predictions to talk about at the water cooler.",
          draft: false,
          resultsPublished: true,
          releaseAt: "2026-07-20T18:00:00Z", // in the past — already revealed
          locked: true,
          scoring: { resultPoints: 3, homeGoalPoints: 1, awayGoalPoints: 1, marginPoints: 1 },
          pairings: league1Schedule[0] ?? null,
          freeMatchIndex: null,
          customMatches: {},
          matches: [
            { id: "l1m1", home: "Northgate United", away: "Ashford Rovers", kickoff: "2026-07-19T15:00:00Z", outcome: { home: 2, away: 1 } },
            { id: "l1m2", home: "Millbrook City", away: "Sterling Athletic", kickoff: "2026-07-19T17:30:00Z", outcome: { home: 0, away: 0 } },
            { id: "l1m3", home: "Hartley Town", away: "Copper Vale FC", kickoff: "2026-07-19T19:45:00Z", outcome: { home: 1, away: 3 } },
          ],
        },
        {
          id: "l1md2",
          label: "Matchday 2",
          blog: "Big rematches this round — Northgate host Millbrook looking to bounce back, while Sterling and Copper Vale face off again after that thriller. Get your predictions in before kickoff!",
          draft: false,
          resultsPublished: false,
          releaseAt: "2026-08-05T18:00:00Z", // in the future — still hidden
          locked: false,
          scoring: { resultPoints: 3, homeGoalPoints: 1, awayGoalPoints: 1, marginPoints: 1 },
          pairings: league1Schedule[1] ?? null,
          freeMatchIndex: 2,
          customMatches: {},
          matches: [
            { id: "l1m4", home: "Northgate United", away: "Millbrook City", kickoff: "2026-08-02T15:00:00Z", outcome: null },
            { id: "l1m5", home: "Ashford Rovers", away: "Hartley Town", kickoff: "2026-08-02T17:30:00Z", outcome: null },
            { id: "l1m6", home: "Sterling Athletic", away: "Copper Vale FC", kickoff: "2026-08-02T19:45:00Z", outcome: null },
          ],
        },
      ],
      fixturePool: [
        { id: "l1f1", home: "Northgate United", away: "Hartley Town", kickoff: "2026-08-16T15:00:00Z" },
        { id: "l1f2", home: "Copper Vale FC", away: "Millbrook City", kickoff: "2026-08-16T15:00:00Z" },
        { id: "l1f3", home: "Sterling Athletic", away: "Ashford Rovers", kickoff: "2026-08-16T17:30:00Z" },
        { id: "l1f4", home: "Ashford Rovers", away: "Copper Vale FC", kickoff: "2026-08-23T15:00:00Z" },
        { id: "l1f5", home: "Millbrook City", away: "Northgate United", kickoff: "2026-08-23T15:00:00Z" },
        { id: "l1f6", home: "Hartley Town", away: "Sterling Athletic", kickoff: "2026-08-23T17:30:00Z" },
      ],
    },
    league2: {
      name: "PLP Championship",
      enabled: true,
      maxParticipants: 24,
      minParticipants: 2,
      h2hSchedule: league2Schedule,
      participants: [
        { id: "l2p1", name: "Elin", code: randomInviteCode() },
        { id: "l2p2", name: "Marco", code: randomInviteCode() },
        { id: "l2p3", name: "Zainab", code: randomInviteCode() },
        { id: "l2p4", name: "Devon", code: randomInviteCode() },
        { id: "l2p5", name: "Ravi", code: randomInviteCode() },
      ],
      matchdays: [
        {
          id: "l2md1",
          label: "Matchday 1",
          blog: "A tight opening round in the Championship — Ironbridge and Westhaven shared the points, Fenwick edged past Castlemoor, and Dunmore snuck past Briar City on the road.",
          draft: false,
          resultsPublished: true,
          releaseAt: "2026-07-20T18:00:00Z",
          locked: true,
          scoring: { resultPoints: 3, homeGoalPoints: 1, awayGoalPoints: 1, marginPoints: 1 },
          pairings: league2Schedule[0] ?? null,
          freeMatchIndex: null,
          customMatches: {},
          matches: [
            { id: "l2m1", home: "Ironbridge FC", away: "Westhaven United", kickoff: "2026-07-19T15:00:00Z", outcome: { home: 1, away: 1 } },
            { id: "l2m2", home: "Fenwick Town", away: "Castlemoor Athletic", kickoff: "2026-07-19T17:30:00Z", outcome: { home: 2, away: 0 } },
            { id: "l2m3", home: "Briar City", away: "Dunmore Rovers", kickoff: "2026-07-19T19:45:00Z", outcome: { home: 0, away: 1 } },
          ],
        },
        {
          id: "l2md2",
          label: "Matchday 2",
          blog: "Round two in the Championship. Westhaven and Fenwick will want to build on their form, and Dunmore travel to Ironbridge fresh off a win. Should be a good one.",
          draft: false,
          resultsPublished: false,
          releaseAt: "2026-08-05T18:00:00Z",
          locked: false,
          scoring: { resultPoints: 3, homeGoalPoints: 1, awayGoalPoints: 1, marginPoints: 1 },
          pairings: league2Schedule[1] ?? null,
          freeMatchIndex: 2,
          customMatches: {},
          matches: [
            { id: "l2m4", home: "Westhaven United", away: "Fenwick Town", kickoff: "2026-08-02T15:00:00Z", outcome: null },
            { id: "l2m5", home: "Castlemoor Athletic", away: "Briar City", kickoff: "2026-08-02T17:30:00Z", outcome: null },
            { id: "l2m6", home: "Dunmore Rovers", away: "Ironbridge FC", kickoff: "2026-08-02T19:45:00Z", outcome: null },
          ],
        },
      ],
      fixturePool: [
        { id: "l2f1", home: "Ironbridge FC", away: "Fenwick Town", kickoff: "2026-08-16T15:00:00Z" },
        { id: "l2f2", home: "Dunmore Rovers", away: "Castlemoor Athletic", kickoff: "2026-08-16T15:00:00Z" },
        { id: "l2f3", home: "Briar City", away: "Westhaven United", kickoff: "2026-08-16T17:30:00Z" },
        { id: "l2f4", home: "Westhaven United", away: "Dunmore Rovers", kickoff: "2026-08-23T15:00:00Z" },
        { id: "l2f5", home: "Castlemoor Athletic", away: "Ironbridge FC", kickoff: "2026-08-23T15:00:00Z" },
        { id: "l2f6", home: "Fenwick Town", away: "Briar City", kickoff: "2026-08-23T17:30:00Z" },
      ],
    },
    league3: emptyLeagueSlot("PLP League One", 24, 2),
    league4: emptyLeagueSlot("PLP League Two", 24, 2),
  },
  predictions: {
    // League 1, Matchday 1 (revealed)
    l1m1__l1p1: { home: 2, away: 1, submittedAt: "2026-07-18T10:00:00Z" }, // correct
    l1m1__l1p2: { home: 1, away: 1, submittedAt: "2026-07-18T10:05:00Z" }, // wrong
    l1m1__l1p3: { home: 3, away: 0, submittedAt: "2026-07-18T11:00:00Z" }, // correct result, wrong score
    l1m2__l1p1: { home: 0, away: 0, submittedAt: "2026-07-18T10:00:00Z" }, // correct
    l1m2__l1p4: { home: 1, away: 0, submittedAt: "2026-07-18T12:00:00Z" }, // wrong
    l1m3__l1p3: { home: 0, away: 2, submittedAt: "2026-07-18T11:05:00Z" }, // correct
    l1m3__l1p5: { home: 1, away: 1, submittedAt: "2026-07-18T13:00:00Z" }, // wrong
    // League 1, Matchday 2 (still hidden — release date in the future)
    l1m4__l1p1: { home: 1, away: 1, submittedAt: "2026-07-27T09:00:00Z" },
    l1m4__l1p2: { home: 2, away: 0, submittedAt: "2026-07-27T09:30:00Z" },
    l1m5__l1p3: { home: 0, away: 1, submittedAt: "2026-07-27T10:00:00Z" },
    // League 2, Matchday 1 (revealed)
    l2m1__l2p1: { home: 1, away: 1, submittedAt: "2026-07-18T10:00:00Z" }, // correct
    l2m1__l2p2: { home: 2, away: 0, submittedAt: "2026-07-18T10:10:00Z" }, // wrong
    l2m2__l2p3: { home: 2, away: 1, submittedAt: "2026-07-18T11:00:00Z" }, // correct result
    l2m2__l2p4: { home: 0, away: 0, submittedAt: "2026-07-18T11:30:00Z" }, // wrong
    l2m3__l2p1: { home: 0, away: 1, submittedAt: "2026-07-18T12:00:00Z" }, // correct
    l2m3__l2p5: { home: 1, away: 1, submittedAt: "2026-07-18T12:30:00Z" }, // wrong
    // League 2, Matchday 2 (still hidden)
    l2m4__l2p2: { home: 1, away: 2, submittedAt: "2026-07-27T09:00:00Z" },
    l2m5__l2p3: { home: 1, away: 1, submittedAt: "2026-07-27T09:45:00Z" },
  },
  };
}

// ---------------------------------------------------------------------------
// Scoring engine
// ---------------------------------------------------------------------------
function resultOf(home, away) {
  if (home > away) return "home";
  if (away > home) return "away";
  return "draw";
}

function scoreMatch(match, prediction, scoring) {
  if (!match.outcome) return { points: 0, evaluated: false, correct: false };
  if (!prediction) return { points: 0, evaluated: true, correct: false };
  const actual = match.outcome;

  const resultCorrect = resultOf(prediction.home, prediction.away) === resultOf(actual.home, actual.away);
  const homeCorrect = prediction.home === actual.home;
  const awayCorrect = prediction.away === actual.away;
  const marginCorrect = (prediction.home - prediction.away) === (actual.home - actual.away);

  let points = 0;
  if (resultCorrect) points += scoring.resultPoints;
  if (homeCorrect) points += scoring.homeGoalPoints;
  if (awayCorrect) points += scoring.awayGoalPoints;
  if (marginCorrect) points += scoring.marginPoints;

  return { points, evaluated: true, correct: resultCorrect, breakdown: { resultCorrect, homeCorrect, awayCorrect, marginCorrect } };
}

function maxMatchPoints(scoring) {
  return scoring.resultPoints + scoring.homeGoalPoints + scoring.awayGoalPoints + scoring.marginPoints;
}

// Points earned by each participant for one matchday only — used for the
// admin's "check before you publish" preview, not the running standings.
// Turns a pairing's custom-match definition into a plain match object with
// a stable id, so it can flow through the same scoring code as any other
// match. The id is deterministic (matchday + home contestant) so both
// contestants in the pairing — who each submit their own prediction — are
// always scored against the exact same fixture.
function customMatchAsMatch(matchday, homeParticipantId, custom) {
  return {
    id: `custom__${matchday.id}__${homeParticipantId}`,
    home: custom.home,
    away: custom.away,
    kickoff: null,
    outcome: custom.outcome ?? null,
  };
}

// -----------------------------------------------------------------------------
// BONANZA MATCHDAYS — a rare special round (admin's discretion, a couple of
// times a season) where EVERY contestant picks their own matches instead of
// predicting the admin's chosen three:
//   - the pairing's HOME contestant picks all 3 matches themselves
//   - the AWAY contestant (and anyone on a bye) picks matches 1 and 2, and
//     predicts the admin's Match 3 (the "anchor") like a normal fixture
// Division rules (communicated in the picker, like the normal free match):
//   Premier League home: any 3 PL matches. Other divisions' home: 2 PL
//   matches + Match 3 from any division (PL down to the National League).
//   Away contestants everywhere: 2 PL matches + the anchor.
// The admin's three entered fixtures stay as FALLBACKS — anyone who never
// makes a pick for a slot is simply scored on the admin's fixture there,
// so nobody is ever left without a match. Scoring, head-to-head and
// publishing all work exactly as on a normal matchday.
// -----------------------------------------------------------------------------
// Which slots a participant picks for themselves on a Bonanza matchday —
// [0,1,2] for pairing homes, [0,1] for aways and byes, null if this isn't
// a Bonanza matchday or they're not part of it.
function bonanzaSlotsFor(matchday, participantId) {
  if (!matchday.bonanza || !matchday.pairings || !participantId) return null;
  const isHome = matchday.pairings.pairings.some((p) => p.home === participantId);
  if (isHome) return [0, 1, 2];
  const isAway = matchday.pairings.pairings.some((p) => p.away === participantId);
  const isBye = matchday.pairings.bye === participantId;
  if (isAway || isBye) return [0, 1];
  return null;
}

// The 3 matches a given participant is actually being scored on for this
// matchday. Normally that's just matchday.matches for everyone — but once
// admin has marked one slot as "free" (matchday.freeMatchIndex), a
// pairing's HOME contestant may swap that slot for a custom match of
// their own choosing. Only the home contestant is affected — their
// opponent always predicts the admin's pre-determined match at that slot,
// regardless of what the home contestant picked. On a Bonanza matchday
// (see above) the substitution instead applies per-slot for everyone,
// using their saved picks in matchday.bonanzaPicks.
function effectiveMatchesFor(matchday, participantId) {
  if (matchday.bonanza) {
    const slots = bonanzaSlotsFor(matchday, participantId);
    if (!slots) return matchday.matches;
    return matchday.matches.map((m, i) => {
      if (!slots.includes(i)) return m;
      const pick = matchday.bonanzaPicks?.[participantId]?.[i];
      // Each pick carries its own unique id (stamped when it was chosen),
      // so a cleared-and-repicked slot can never inherit a prediction that
      // was made against the previous pick's teams.
      return pick ? { id: pick.id, home: pick.home, away: pick.away, kickoff: null, outcome: pick.outcome ?? null } : m;
    });
  }
  if (matchday.freeMatchIndex === null || matchday.freeMatchIndex === undefined || !matchday.pairings) {
    return matchday.matches;
  }
  const pairing = matchday.pairings.pairings.find((p) => p.home === participantId);
  if (!pairing) return matchday.matches; // away contestant, a bye, or not part of this matchday
  const custom = matchday.customMatches?.[participantId];
  if (!custom) return matchday.matches;
  return matchday.matches.map((m, i) => (i === matchday.freeMatchIndex ? customMatchAsMatch(matchday, participantId, custom) : m));
}

function computeMatchdayPoints(matchday, predictions, participants) {
  const rows = participants.map((p) => {
    let points = 0, correct = 0;
    effectiveMatchesFor(matchday, p.id).forEach((m) => {
      const pred = predictions[`${m.id}__${p.id}`];
      const result = scoreMatch(m, pred, matchday.scoring);
      if (result.evaluated) {
        points += result.points;
        if (result.correct) correct += 1;
      }
    });
    return { id: p.id, name: p.name, points: Math.round(points * 10) / 10, correct };
  });
  rows.sort((a, b) => b.points - a.points);
  return rows;
}

// -----------------------------------------------------------------------------
// HEAD-TO-HEAD FORMAT — each matchday, contestants are paired up (per a
// season-long schedule generated in advance) and compete directly against
// their opponent: whoever earns more prediction points that matchday wins
// the head-to-head fixture (3 league points), a tie draws (1 point each),
// and the margin between the two scores ("score difference") is the
// tiebreaker for the table. The per-match/per-matchday prediction scoring
// itself (scoreMatch, computeMatchdayPoints above) is unchanged — this
// layer just decides what those raw points are worth in the standings.
// -----------------------------------------------------------------------------

// Double round-robin (circle method): every contestant plays every other
// contestant twice — once with each as "home" — which for N contestants
// produces exactly 2*(N-1) rounds (38 for 20 contestants, 30 for 16,
// matching a normal top-flight football season). An odd contestant count
// gets a rotating bye each round instead of a pairing.
function generateRoundRobinSchedule(participantIds) {
  let ids = [...participantIds];
  if (ids.length < 2) return [];
  const hasBye = ids.length % 2 !== 0;
  if (hasBye) ids.push(null);
  const n = ids.length;
  const half = n / 2;
  let arr = [...ids];
  const firstLeg = [];
  for (let r = 0; r < n - 1; r++) {
    const pairings = [];
    let bye = null;
    for (let i = 0; i < half; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a === null) bye = b;
      else if (b === null) bye = a;
      else pairings.push({ home: a, away: b });
    }
    firstLeg.push({ pairings, bye });
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }
  const secondLeg = firstLeg.map(({ pairings, bye }) => ({
    pairings: pairings.map((p) => ({ home: p.away, away: p.home })),
    bye,
  }));
  return [...firstLeg, ...secondLeg];
}

// A bye counts as an automatic win with a neutral (zero) score difference —
// it shouldn't be possible to boost your tiebreaker standing just by being
// the odd one out that round.
const BYE_RESULT = { leaguePoints: 3, scoreDiff: 0, opponentId: null, ownRaw: null, opponentRaw: null, outcome: "bye" };

// Resolves one matchday's pairings (attached to the matchday when it was
// created — see AdminView's matchday generation) into each involved
// participant's head-to-head result for that matchday. Returns {} if this
// matchday has no pairings attached (e.g. created before a schedule existed).
function computeH2HResultsForMatchday(matchday, predictions, participants) {
  if (!matchday.pairings) return {};
  const rawRows = computeMatchdayPoints(matchday, predictions, participants);
  const rawById = Object.fromEntries(rawRows.map((r) => [r.id, r.points]));
  const results = {};

  matchday.pairings.pairings.forEach(({ home, away }) => {
    const homeRaw = rawById[home] ?? 0;
    const awayRaw = rawById[away] ?? 0;
    if (homeRaw > awayRaw) {
      results[home] = { leaguePoints: 3, scoreDiff: homeRaw - awayRaw, opponentId: away, ownRaw: homeRaw, opponentRaw: awayRaw, outcome: "win" };
      results[away] = { leaguePoints: 0, scoreDiff: awayRaw - homeRaw, opponentId: home, ownRaw: awayRaw, opponentRaw: homeRaw, outcome: "loss" };
    } else if (awayRaw > homeRaw) {
      results[away] = { leaguePoints: 3, scoreDiff: awayRaw - homeRaw, opponentId: home, ownRaw: awayRaw, opponentRaw: homeRaw, outcome: "win" };
      results[home] = { leaguePoints: 0, scoreDiff: homeRaw - awayRaw, opponentId: away, ownRaw: homeRaw, opponentRaw: awayRaw, outcome: "loss" };
    } else {
      results[home] = { leaguePoints: 1, scoreDiff: 0, opponentId: away, ownRaw: homeRaw, opponentRaw: awayRaw, outcome: "draw" };
      results[away] = { leaguePoints: 1, scoreDiff: 0, opponentId: home, ownRaw: awayRaw, opponentRaw: homeRaw, outcome: "draw" };
    }
  });

  if (matchday.pairings.bye) {
    results[matchday.pairings.bye] = { ...BYE_RESULT, ownRaw: rawById[matchday.pairings.bye] ?? 0 };
  }
  return results;
}


function isReleased(matchday, now) {
  if (!matchday.releaseAt) return false;
  return new Date(matchday.releaseAt).getTime() <= now;
}

// Whether predictions are closed for a matchday: closed manually by admin
// (the locked flag, kept as an override for locking early or in special
// circumstances) or automatically once the matchday's "predictions close
// at" deadline passes. The deadline needs nobody to be online to take
// effect — every view computes it live against the clock, and submissions
// double-check it at the moment of saving. To reopen after a deadline has
// passed, admin extends or clears the deadline in the matchday card.
function isPredictionsClosed(matchday, now = Date.now()) {
  if (matchday.locked) return true;
  return !!matchday.predictionsCloseAt && new Date(matchday.predictionsCloseAt).getTime() <= now;
}

// `adminMode` only affects the label shown for a fully-scored-but-unpublished
// matchday: admins see "pending publish" (a nudge to go confirm it), while
// contestants just see it as still "locked" until the admin publishes.
function matchdayDisplayStatus(matchday, adminMode = false, now = Date.now()) {
  if (matchday.draft) return "draft";
  const allScored = matchday.matches.every((m) => m.outcome);
  if (allScored && matchday.resultsPublished) return "completed";
  if (allScored && !matchday.resultsPublished) return adminMode ? "pending publish" : "locked";
  if (isPredictionsClosed(matchday, now)) return "locked";
  return "open";
}

function cellStatus(matchday, hasPrediction, now = Date.now()) {
  if (hasPrediction) return "submitted";
  if (isPredictionsClosed(matchday, now)) return "locked";
  return "pending";
}

const cx = (...c) => c.filter(Boolean).join(" ");

const STATUS_STYLES = {
  submitted: "bg-emerald-50 text-emerald-700 border-emerald-300/30",
  pending: "bg-zinc-400/10 text-stone-500 border-zinc-500/30",
  locked: "bg-rose-50 text-rose-700 border-rose-300/30",
};
const STATUS_ICON = { submitted: CheckCircle2, pending: Clock, locked: Lock };
const MATCHDAY_STATUS_STYLES = {
  draft: "bg-white/5 text-stone-500 border-stone-300 border-dashed",
  open: "bg-white/5 text-stone-900 border-stone-400",
  locked: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  "pending publish": "bg-amber-400/10 text-amber-300 border-amber-400/30",
  completed: "bg-amber-400 text-black border-amber-400",
};

// Renames leagues from the old generic "League 1/2" test names to the real
// ones, and backfills fields added in later versions (like `accounts`), so
// anyone who already has data saved from earlier testing doesn't need to
// start over.
function migrateData(data) {
  if (data.leagues?.league1?.name === "League 1") data.leagues.league1.name = "PLP Premier League";
  if (data.leagues?.league2?.name === "League 2") data.leagues.league2.name = "PLP Championship";
  if (!data.accounts) data.accounts = {};
  if (typeof data.lastManualExportAt === "undefined") data.lastManualExportAt = null;
  if (typeof data.seasonLabel !== "string") data.seasonLabel = "2026-27";
  if (!Array.isArray(data.seasonArchives)) data.seasonArchives = [];
  if (!Array.isArray(data.legacyHonours)) data.legacyHonours = [];
  if (!data.historyPage || typeof data.historyPage !== "object") data.historyPage = { text: "", images: [] };
  if (typeof data.historyPage.text !== "string") data.historyPage.text = "";
  if (!Array.isArray(data.historyPage.images)) data.historyPage.images = [];
  // Backfill any division slots that didn't exist yet (League One / League
  // Two are new) so older saved data still has all four slots to work with.
  LEAGUE_DEFS.forEach((def) => {
    if (!data.leagues[def.key]) {
      data.leagues[def.key] = emptyLeagueSlot(def.defaultName, def.defaultMaxParticipants, def.defaultMinParticipants);
    }
  });
  Object.entries(data.leagues).forEach(([key, league]) => {
    const def = LEAGUE_DEFS.find((d) => d.key === key);
    if (typeof league.enabled !== "boolean") {
      // A division that already has real data (participants or matchdays)
      // was clearly in active use, so migration preserves that regardless
      // of which slot it happens to be — Championship is treated exactly
      // like League One/Two here, not as a special case.
      league.enabled = def?.alwaysEnabled || league.participants.length > 0 || league.matchdays.length > 0;
    }
    if (def?.alwaysEnabled) league.enabled = true;
    if (typeof league.maxParticipants !== "number") {
      league.maxParticipants = def?.defaultMaxParticipants ?? DEFAULT_MAX_PARTICIPANTS;
    }
    if (typeof league.minParticipants !== "number") {
      league.minParticipants = def?.defaultMinParticipants ?? DEFAULT_MIN_PARTICIPANTS;
    }
    league.participants.forEach((p) => {
      if (!p.code) p.code = randomInviteCode();
    });
    if (!league.fixturePool) league.fixturePool = [];
    if (!Array.isArray(league.h2hSchedule)) league.h2hSchedule = [];
    if (!Array.isArray(league.adjustments)) league.adjustments = []; // manual standings corrections — see AdjustmentsCard
    league.h2hSchedule.forEach((round) => {
      if (typeof round.scheduledDate === "undefined") round.scheduledDate = null;
    });
    league.matchdays.forEach((md) => {
      if (typeof md.draft !== "boolean") md.draft = false;
      if (typeof md.blog !== "string") md.blog = "";
      if (typeof md.closingBlog !== "string") md.closingBlog = ""; // the results-day review — see MatrixView
      if (typeof md.predictionsCloseAt === "undefined") md.predictionsCloseAt = null; // auto-lock deadline — see isPredictionsClosed()
      if (typeof md.pairings === "undefined") md.pairings = null;
      if (typeof md.scheduledDate === "undefined") md.scheduledDate = null;
      if (typeof md.freeMatchIndex === "undefined") md.freeMatchIndex = null;
      if (!md.customMatches) md.customMatches = {};
      if (typeof md.bonanza !== "boolean") md.bonanza = false; // rare special matchdays — see bonanzaSlotsFor()
      if (!md.bonanzaPicks) md.bonanzaPicks = {};
      // Grandfather in matchdays from before the publish-gate existed: if
      // every match already has a result, treat it as already published so
      // standings people had already seen don't disappear.
      if (typeof md.resultsPublished !== "boolean") {
        md.resultsPublished = md.matches.every((m) => m.outcome);
      }
    });
  });
  return data;
}

// Breaks the single unified `data` shape (what every component in this app
// reads and writes) into the separate storage keys described above.
function splitData(data) {
  const stripPhoto = (p) => {
    const { photo, badge, ...rest } = p;
    return rest;
  };
  const leagueMeta = {};
  const rosterLeagues = {};
  const photos = {};
  const badges = {};
  Object.entries(data.leagues).forEach(([key, league]) => {
    leagueMeta[key] = {
      name: league.name,
      enabled: league.enabled,
      maxParticipants: league.maxParticipants,
      minParticipants: league.minParticipants,
      h2hSchedule: league.h2hSchedule,
      matchdays: league.matchdays,
      fixturePool: league.fixturePool,
      adjustments: league.adjustments ?? [],
    };
    rosterLeagues[key] = { participants: league.participants.map(stripPhoto) };
    league.participants.forEach((p) => {
      if (p.photo) photos[p.id] = p.photo;
      if (p.badge) badges[p.id] = p.badge;
    });
  });
  return {
    core: { adminPin: data.adminPin, lastManualExportAt: data.lastManualExportAt, seasonLabel: data.seasonLabel, leagueMeta },
    accountsBlob: { accounts: data.accounts },
    rosterBlob: { leagues: rosterLeagues },
    photosBlob: { photos },
    predictionsBlob: { predictions: data.predictions },
    archivesBlob: { seasonArchives: data.seasonArchives, legacyHonours: data.legacyHonours },
    badgesBlob: { badges },
    historyBlob: { historyPage: data.historyPage },
  };
}

// The inverse of splitData — reconstructs the unified shape the rest of the
// app expects from the 8 separately-loaded pieces.
function mergeSplitData(core, accountsBlob, rosterBlob, photosBlob, predictionsBlob, archivesBlob, badgesBlob, historyBlob) {
  const leagues = {};
  Object.keys(core.leagueMeta).forEach((key) => {
    const roster = rosterBlob.leagues[key]?.participants ?? [];
    leagues[key] = {
      ...core.leagueMeta[key],
      participants: roster.map((p) => ({ ...p, photo: photosBlob.photos[p.id] ?? null, badge: badgesBlob.badges[p.id] ?? null })),
    };
  });
  return {
    adminPin: core.adminPin,
    lastManualExportAt: core.lastManualExportAt,
    seasonLabel: core.seasonLabel,
    seasonArchives: archivesBlob.seasonArchives ?? [],
    legacyHonours: archivesBlob.legacyHonours ?? [],
    historyPage: historyBlob.historyPage ?? { text: "", images: [] },
    accounts: accountsBlob.accounts ?? {},
    predictions: predictionsBlob.predictions ?? {},
    leagues,
  };
}

// Writes all 8 split keys from a unified `data` object.
// Reads that decide "is this a brand-new install with nothing saved yet"
// carry real weight — getting that wrong means overwriting genuine saved
// data with an empty seed. A single empty read is never trusted for that
// decision on its own; it's retried a few times first, so a one-off timing
// hiccup can't be mistaken for "nothing was ever saved here."
async function getWithRetry(key, attempts = 4, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    const res = await window.storage.get(key, true);
    if (res && res.value) return res;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null; // consistently empty across every attempt
}

// Same reasoning as getWithRetry, applied to writes: a single failed
// attempt to save one key isn't trusted as a genuine failure on its own.
// It's retried a few times first, with a short pause between attempts, so
// a one-off hiccup mid-burst doesn't get reported as a real failure when
// it's actually just a transient blip.
async function setWithRetry(key, json, attempts = 3, delayMs = 400) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await window.storage.set(key, json, true);
      return;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function writeSplitData(data) {
  const { core, accountsBlob, rosterBlob, photosBlob, predictionsBlob, archivesBlob, badgesBlob, historyBlob } = splitData(data);
  // Named entries, written one at a time (not all at once) — sequencing
  // keeps write bursts gentle on the backend and makes failures easier to
  // attribute. Still independent of each other: one failing doesn't stop
  // the rest from being attempted.
  const entries = [
    ["core settings", CORE_KEY, core],
    ["accounts", ACCOUNTS_KEY, accountsBlob],
    ["roster", ROSTER_KEY, rosterBlob],
    ["profile photos", PHOTOS_KEY, photosBlob],
    ["predictions", PREDICTIONS_KEY, predictionsBlob],
    ["season archives", SEASON_ARCHIVES_KEY, archivesBlob],
    ["badges", BADGES_KEY, badgesBlob],
    ["history page", HISTORY_KEY, historyBlob],
  ];
  const failed = [];
  for (const [label, key, blob] of entries) {
    try {
      const json = JSON.stringify(blob);
      await setWithRetry(key, json);
    } catch {
      failed.push(label);
    }
  }
  if (failed.length > 0) {
    const err = new Error(`Failed to save: ${failed.join(", ")}`);
    err.failedParts = failed;
    throw err;
  }
}

// -----------------------------------------------------------------------------
// STALE-WRITE PROTECTION — every full save is stamped with a version ("rev").
// Each open tab remembers the rev its data came from; before saving, it
// checks the database still holds that same rev, and claims the next one
// with an atomic compare-and-swap. A tab whose data is out of date (because
// someone else — or another tab on the same machine — saved in the
// meantime) is refused with a "refresh first" message instead of silently
// overwriting the newer data with its stale copy. Prediction submissions
// are exempt from the check (they already read-merge-write safely and must
// never be blocked by unrelated admin edits) but they still bump the rev,
// so any other open tab knows its full copy of the world is now stale.
// -----------------------------------------------------------------------------
const REV_KEY = "plp-2026-27-rev-v1";
const STALE_SAVE_MESSAGE =
  "Your change wasn't saved because this page's data is out of date — someone else (or another tab) has saved changes since this page last loaded. Refresh the page to pick up the latest data, then redo your change.";

async function readRevValue() {
  const res = await window.storage.get(REV_KEY, true);
  return res && res.value ? res.value : null;
}

function nextRevValue(currentValue) {
  let rev = 0;
  try {
    rev = currentValue ? (JSON.parse(currentValue).rev ?? 0) : 0;
  } catch {
    rev = 0;
  }
  return JSON.stringify({ rev: rev + 1, token: randomSaltHex(4), updatedAt: new Date().toISOString() });
}

// Claims the next rev. When the database supports it (our adapter does),
// this is a genuinely atomic compare-and-swap — two racing tabs can never
// both succeed. Falls back to a plain write for a first-ever rev (nothing
// to compare against yet) or if the adapter lacks the operation.
async function claimRev(currentValue, newValue) {
  if (currentValue !== null && typeof window.storage.compareAndSwap === "function") {
    return window.storage.compareAndSwap(REV_KEY, currentValue, newValue);
  }
  await window.storage.set(REV_KEY, newValue, true);
  return true;
}

// --- Password hashing (Web Crypto SHA-256 + a random per-account salt) ---
// Passwords are never stored in plain text. This is still client-side
// hashing with no server-side auth layer to keep secrets away from a
// determined user — see the note in the app's footer about what this does
// and doesn't protect against.
function bufferToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bufferToHex(digest);
}
// Short, human-shareable invite codes (no ambiguous 0/O/1/I characters) —
// one per contestant. The admin hands these out privately; a contestant
// must supply theirs to register, so nobody can register as someone else.
const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomInviteCode(length = 6) {
  let code = "";
  for (let i = 0; i < length; i++) code += INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)];
  return code;
}

function randomSaltHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}
function fmtDateOnly(iso) {
  if (!iso) return null;
  try {
    return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  } catch {
    return iso;
  }
}
function toLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// =============================================================================
// APP
// =============================================================================
// -----------------------------------------------------------------------------
// ERROR BOUNDARY — one bug anywhere in the tree used to take the whole app
// down to a blank screen for everyone. This catches render/lifecycle errors
// (not errors inside async storage calls, which are already try/caught at
// the source) and shows a recoverable screen instead of nothing at all.
// -----------------------------------------------------------------------------
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    // Best-effort logging only — there's no server to send this to, but it
    // still shows up in the browser console for anyone debugging live.
    console.error("PLP 2026-27 crashed:", error, info?.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[500px] w-full flex items-center justify-center bg-stone-100 text-stone-900 px-4">
          <div className="max-w-sm text-center space-y-4">
            <Logo className="h-16 w-auto object-contain mx-auto" />
            <h2 className="font-display font-bold text-lg text-rose-700">Something went wrong</h2>
            <p className="text-sm text-stone-500">
              The app hit an unexpected error and couldn't continue. Nothing you've already saved is affected — reloading should get you back in.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-violet-700 hover:bg-violet-600 text-white font-display font-semibold rounded-lg px-4 py-2 text-sm"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function ForecastRoom() {
  return (
    <ErrorBoundary>
      <ForecastRoomApp />
    </ErrorBoundary>
  );
}

function ForecastRoomApp() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [currentUser, setCurrentUser] = useState(null); // { email, name, leagueKey, participantId }
  const [leagueKey, setLeagueKey] = useState("league1");
  const [globalView, setGlobalView] = useState(null); // null | "honours" | "history" — sits outside the division tabs
  const [adminMode, setAdminMode] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [snapshots, setSnapshots] = useState([]); // rotating automatic backups: [{ timestamp, data }]
  const [saveError, setSaveError] = useState(null); // non-null whenever the most recent save genuinely failed
  const dataRef = useRef(null);
  const snapshotsRef = useRef([]);
  const revRef = useRef(null); // the save-version stamp this tab's data came from — see REV_KEY above
  // Chains every save so only one is ever actually in flight at a time —
  // without this, rapidly triggering several saves in a row (e.g. removing
  // multiple contestants back to back) can start a new save before the
  // previous one's requests have finished, letting them collide with each
  // other even though each save's own 8 requests are already sequenced.
  const persistQueueRef = useRef(Promise.resolve());

  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { snapshotsRef.current = snapshots; }, [snapshots]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Read one key at a time (not all at once) — same reasoning as
        // writeSplitData. Any failure here still falls through to the catch
        // block below exactly as before, so a transient read failure can
        // never be mistaken for "no data exists yet" and risk overwriting
        // real saved data with a fresh seed.
        const coreRes = await getWithRetry(CORE_KEY);
        const accountsRes = await window.storage.get(ACCOUNTS_KEY, true);
        const rosterRes = await window.storage.get(ROSTER_KEY, true);
        const photosRes = await window.storage.get(PHOTOS_KEY, true);
        const predictionsRes = await window.storage.get(PREDICTIONS_KEY, true);
        const archivesRes = await window.storage.get(SEASON_ARCHIVES_KEY, true);
        const badgesRes = await window.storage.get(BADGES_KEY, true);
        const historyRes = await window.storage.get(HISTORY_KEY, true);
        const revRes = await window.storage.get(REV_KEY, true);
        if (cancelled) return;
        // Remember which save-version this data came from — every future
        // save from this tab is checked against it (stale-write protection).
        revRef.current = revRes && revRes.value ? revRes.value : null;

        if (coreRes && coreRes.value) {
          // Already on the split-storage format.
          const merged = mergeSplitData(
            JSON.parse(coreRes.value),
            accountsRes && accountsRes.value ? JSON.parse(accountsRes.value) : { accounts: {} },
            rosterRes && rosterRes.value ? JSON.parse(rosterRes.value) : { leagues: {} },
            photosRes && photosRes.value ? JSON.parse(photosRes.value) : { photos: {} },
            predictionsRes && predictionsRes.value ? JSON.parse(predictionsRes.value) : { predictions: {} },
            archivesRes && archivesRes.value ? JSON.parse(archivesRes.value) : { seasonArchives: [] },
            badgesRes && badgesRes.value ? JSON.parse(badgesRes.value) : { badges: {} },
            historyRes && historyRes.value ? JSON.parse(historyRes.value) : { historyPage: { text: "", images: [] } }
          );
          setData(migrateData(merged));
          return;
        }

        // Not split yet — see if there's data under the old single-blob key
        // from before this update, and migrate it into the split keys.
        // Same retry safeguard applies here for the same reason.
        const legacyRes = await getWithRetry(STORAGE_KEY);
        if (legacyRes && legacyRes.value) {
          const migrated = migrateData(JSON.parse(legacyRes.value));
          setData(migrated);
          await writeSplitData(migrated);
          const initialRev = nextRevValue(revRef.current);
          await window.storage.set(REV_KEY, initialRev, true);
          revRef.current = initialRev;
          return;
        }

        // Brand new install — nothing saved anywhere yet, confirmed by
        // several consecutive empty reads, not just one.
        const seed = seedData();
        setData(seed);
        await writeSplitData(seed);
        const initialRev = nextRevValue(revRef.current);
        await window.storage.set(REV_KEY, initialRev, true);
        revRef.current = initialRev;
      } catch {
        if (!cancelled) {
          setData(seedData());
          setLoadError(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load previously-saved automatic snapshots (a separate storage key so a
  // snapshot never has to contain a copy of all the earlier snapshots too).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.storage.get(SNAPSHOTS_KEY, true);
        if (cancelled) return;
        setSnapshots(result && result.value ? JSON.parse(result.value) : []);
      } catch {
        /* best-effort — snapshots are a safety net, not core functionality */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Takes a new automatic snapshot if it's been >= 24h since the last one.
  // Uses refs (not state) so the interval below always sees the latest
  // data/snapshots without needing to be re-created on every change.
  const maybeTakeSnapshot = useCallback(async () => {
    if (!dataRef.current) return;
    const current = snapshotsRef.current;
    const last = current[current.length - 1];
    const now = Date.now();
    if (last && now - last.timestamp < SNAPSHOT_INTERVAL_MS) return;
    const next = [...current, { timestamp: now, data: JSON.parse(JSON.stringify(dataRef.current)) }].slice(-MAX_SNAPSHOTS);
    setSnapshots(next);
    try {
      await window.storage.set(SNAPSHOTS_KEY, JSON.stringify(next), true);
    } catch {
      /* best-effort */
    }
  }, []);

  // Once data has loaded for the first time, check immediately, then keep
  // checking hourly for as long as someone has the app open (a snapshot is
  // only ever actually written once 24h have genuinely passed).
  useEffect(() => {
    if (!data) return;
    maybeTakeSnapshot();
    const t = setInterval(maybeTakeSnapshot, 60 * 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data, maybeTakeSnapshot]);

  const persist = useCallback((next) => {
    // Queue this save behind whatever's already running, rather than
    // starting it immediately — see persistQueueRef above for why.
    const run = persistQueueRef.current.then(async () => {
      // STALE-WRITE PROTECTION — before anything is written (or even shown
      // on screen as saved), confirm this tab's data is still current, and
      // atomically claim the next save-version so no other tab can save
      // over the top of this one. A tab holding out-of-date data is refused
      // here, which is what stops it from silently wiping newer changes.
      try {
        const currentRev = await readRevValue();
        if ((revRef.current ?? null) !== (currentRev ?? null)) {
          setSaveError(STALE_SAVE_MESSAGE);
          return false;
        }
        const newRev = nextRevValue(currentRev);
        const claimed = await claimRev(currentRev, newRev);
        if (!claimed) {
          // Another tab beat us to the claim in the tiny window since the
          // check above — same situation, same remedy.
          setSaveError(STALE_SAVE_MESSAGE);
          return false;
        }
        revRef.current = newRev;
      } catch {
        setSaveError("Your last change didn't save — check your connection and try again.");
        return false;
      }
      const previous = dataRef.current;
      setData(next); // optimistic UI update, applied only once it's actually this save's turn
      try {
        await writeSplitData(next);
        setSaveError(null);
        return true;
      } catch (err) {
        // The save genuinely failed — roll the screen back to what's actually
        // saved rather than leave it showing a change that never went through.
        setData(previous);
        const parts = err?.failedParts;
        setSaveError(
          parts && parts.length
            ? `Your last change didn't save — the ${parts.join(", ")} couldn't be written, even after retrying. This is usually a connection issue — try again in a moment. If it keeps happening, download a backup from Admin \u2192 Backups and let your organizer know.`
            : "Your last change didn't save — check your connection and try again."
        );
        return false;
      }
    });
    // Keep the queue chain alive even if this save failed, so the NEXT
    // queued save still runs rather than getting stuck behind a rejection.
    persistQueueRef.current = run.catch(() => {});
    return run;
  }, []);

  // Prediction submissions are the highest-frequency, highest-concurrency
  // write in the app — many contestants could submit around the same
  // deadline. Rather than trusting this browser's possibly-stale in-memory
  // copy of `predictions` (which would silently clobber anyone else's
  // submission since the last time this tab loaded data), this re-reads the
  // predictions key immediately before writing and merges on top of
  // whatever is actually latest there.
  const submitPredictions = useCallback((newEntries) => {
    const run = persistQueueRef.current.then(async () => {
      try {
        // Predictions deliberately skip the stale-write check — this
        // read-merge-write is already safe against clobbering others, and a
        // contestant's submission must never be refused just because admin
        // saved something unrelated. But it still bumps the save-version
        // below, so every OTHER open tab knows its full copy of the data
        // (which includes a predictions blob) is now out of date.
        const currentRev = await readRevValue();
        const wasFresh = (revRef.current ?? null) === (currentRev ?? null);
        const latest = await window.storage.get(PREDICTIONS_KEY, true);
        const latestPredictions = latest && latest.value ? JSON.parse(latest.value).predictions : {};
        const mergedPredictions = { ...latestPredictions, ...newEntries };
        await window.storage.set(PREDICTIONS_KEY, JSON.stringify({ predictions: mergedPredictions }), true);
        try {
          const newRev = nextRevValue(currentRev);
          const claimed = await claimRev(currentRev, newRev);
          // Only advance our own tab's stamp if it was fresh to begin with —
          // a tab that was already stale must stay stale, or its next full
          // save would slip past the protection.
          if (claimed && wasFresh) revRef.current = newRev;
        } catch {
          /* best-effort — the prediction itself is already safely saved */
        }
        setSaveError(null);
        setData((prev) => (prev ? { ...prev, predictions: mergedPredictions } : prev));
        return true;
      } catch {
        // Genuinely couldn't reach storage — don't show the prediction as
        // submitted, since it wasn't. Leave the draft as the contestant typed
        // it so they can see something's wrong and try again.
        setSaveError("Your prediction didn't save — check your connection and try again.");
        return false;
      }
    });
    persistQueueRef.current = run.catch(() => {});
    return run;
  }, []);

  const restoreSnapshot = useCallback(async (snapshotData) => {
    return persist(snapshotData);
  }, [persist]);

  if (!data) {
    return (
      <div className="min-h-[500px] w-full flex items-center justify-center bg-stone-100 text-stone-700">
        <div className="flex flex-col items-center gap-4">
          <Logo className="h-24 w-auto object-contain" />
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <AuthScreen
        data={data}
        persist={persist}
        onLogin={(user) => { setCurrentUser(user); setLeagueKey(user.leagueKey); }}
        snapshots={snapshots}
        onRestoreSnapshot={restoreSnapshot}
        saveError={saveError}
        setSaveError={setSaveError}
      />
    );
  }

  const activeLeagueKeys = enabledLeagueKeys(data);
  const safeLeagueKey = data.leagues[leagueKey]?.enabled ? leagueKey : (activeLeagueKeys[0] ?? "league1");
  const league = data.leagues[safeLeagueKey];
  // A logged-in contestant is only ever "themselves" in the league they
  // registered for — browsing the other league is read-only (no submit).
  const viewerId = safeLeagueKey === currentUser.leagueKey ? currentUser.participantId : "";

  return (
    <div className="min-h-[700px] w-full bg-stone-100 text-stone-900" style={{ fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap');
        .font-display { font-family: 'Oswald', ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; }
        .font-score { font-family: 'Anton', ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.01em; }
        .font-mono-num { font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background: #C7CFC0; border-radius: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
      `}</style>

      <div style={{ background: "#3D1F5C" }} className="w-full">
        <Header data={data} leagueKey={safeLeagueKey} />

        {/* League switcher */}
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex gap-2 pb-2 flex-wrap">
          {activeLeagueKeys.map((k) => (
            <button
              key={k}
              onClick={() => { setLeagueKey(k); setGlobalView(null); }}
              className={cx(
                "px-4 py-2 rounded-xl border text-sm font-display font-semibold flex items-center gap-2 transition-colors",
                !globalView && safeLeagueKey === k ? "text-black" : "border-white/20 text-stone-200 hover:border-white/40"
              )}
              style={!globalView && safeLeagueKey === k ? { background: leagueAccent(k), borderColor: leagueAccent(k) } : undefined}
            >
              {data.leagues[k].name}
            </button>
          ))}
        </div>

        {/* Honours / History — deliberately separate from the division tabs above: these cover every division at once. */}
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex gap-2 pb-4 flex-wrap border-t border-white/10 pt-3">
          <button
            onClick={() => setGlobalView(globalView === "honours" ? null : "honours")}
            className={cx(
              "px-3 py-1.5 rounded-lg border text-xs font-display font-semibold flex items-center gap-1.5 transition-colors",
              globalView === "honours" ? "bg-amber-400 text-black border-amber-400" : "border-amber-400/40 text-amber-300 hover:border-amber-400"
            )}
          >
            <Trophy size={13} /> Honours
          </button>
          <button
            onClick={() => setGlobalView(globalView === "history" ? null : "history")}
            className={cx(
              "px-3 py-1.5 rounded-lg border text-xs font-display font-semibold flex items-center gap-1.5 transition-colors",
              globalView === "history" ? "bg-amber-400 text-black border-amber-400" : "border-amber-400/40 text-amber-300 hover:border-amber-400"
            )}
          >
            <History size={13} /> History
          </button>
        </div>

        {/* The current division's signature colour, as a strip under the banner. */}
        <div style={{ height: 4, background: leagueAccent(safeLeagueKey) }} />
      </div>

      {saveError && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-4">
          <div className="flex items-center gap-2 bg-rose-50 border border-rose-300 text-rose-700 text-sm rounded-lg px-4 py-2.5">
            <AlertCircle size={16} className="shrink-0" />
            <span className="flex-1">{saveError}</span>
            <button onClick={() => setSaveError(null)} className="text-rose-500 hover:text-rose-700 shrink-0"><X size={15} /></button>
          </div>
        </div>
      )}

      {/* Identity / admin control bar */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-2 bg-white border border-stone-200 rounded-lg px-3 py-1.5">
          <UserCircle2 size={14} className="text-amber-400" />
          <span className="text-stone-500">Signed in as</span>
          <span className="font-medium text-stone-900">{currentUser.name}</span>
          <button onClick={() => setCurrentUser(null)} className="ml-1 text-stone-500 hover:text-rose-600" title="Log out">
            <LogOut size={14} />
          </button>
        </div>
        {/* Admin management lives exclusively behind the "Admin access"
            entrance on the login screen — logged-in contestants see no
            admin controls at all. */}
      </div>

      {globalView === "honours" ? (
        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8"><HonoursView data={data} adminMode={adminMode} persist={persist} /></main>
      ) : globalView === "history" ? (
        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8"><HistoryView data={data} adminMode={adminMode} persist={persist} /></main>
      ) : (
        <AppTabs
          league={league}
          leagueKey={safeLeagueKey}
          data={data}
          persist={persist}
          submitPredictions={submitPredictions}
          viewerId={viewerId}
          adminMode={adminMode}
          now={now}
          snapshots={snapshots}
          onRestoreSnapshot={restoreSnapshot}
          allowSubmit
        />
      )}

      <footer className="max-w-6xl mx-auto px-4 sm:px-6 pb-10 pt-4 text-xs text-stone-500 border-t border-stone-200/60 mt-6 space-y-1">
        <p>Data is shared — everyone opening this site sees the same leagues, fixtures and scores.</p>
        <p>
          Passwords are salted and hashed (SHA-256) before they're ever saved — never stored in plain text. That
          said, the login check runs in your browser rather than behind server-side authentication, so it's honest
          security for a friendly league among people who trust each other, not the guarantees of a full
          production auth system with rate-limiting, session tokens, etc. The admin PIN is a separate, simpler
          gate on top.
        </p>
        {loadError && <p>The database wasn't reachable this session, so changes will only last until you reload.</p>}
      </footer>
    </div>
  );
}

function Header({ data, leagueKey }) {
  const league = data.leagues[leagueKey];
  const board = useMemo(() => computeLeaderboardWithPredictions(league.participants, publishedMatchdays(league), data.predictions, league.adjustments), [league, data.predictions]);
  const leader = board[0];
  return (
    <header className="max-w-6xl mx-auto px-4 sm:px-6 pt-10 pb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
      <div>
        <div className="flex items-center gap-2 text-amber-400/90 text-xs font-semibold tracking-[0.2em] uppercase mb-2">
          <Sparkles size={14} /> Season {data.seasonLabel}
        </div>
        <Logo className="h-16 sm:h-20 w-auto object-contain" />
        <p className="text-stone-300 mt-1 text-sm">Same game, same friends, new world</p>
      </div>
      {leader && leader.leaguePoints > 0 && (
        <div className="flex items-center gap-3 bg-white/10 border border-amber-400/30 rounded-xl px-4 py-3">
          <Crown className="text-amber-400" size={28} />
          <div>
            <div className="text-[11px] uppercase tracking-wider text-amber-300/80 font-semibold">{league.name} leader</div>
            <div className="font-display font-bold text-lg leading-tight text-white">{leader.name}</div>
            <div className="font-mono-num text-amber-300 text-sm">{leader.leaguePoints} pts <span className="text-stone-300">· {leader.scoreDifference > 0 ? "+" : ""}{leader.scoreDifference}</span></div>
          </div>
        </div>
      )}
    </header>
  );
}

function AdminGate({ data, adminMode, setAdminMode, persist }) {
  const [entering, setEntering] = useState(false);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");

  if (adminMode) {
    return (
      <button
        onClick={() => setAdminMode(false)}
        className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-300/30 text-emerald-700 rounded-lg px-3 py-1.5 font-medium"
      >
        <Unlock size={14} /> Admin mode on
      </button>
    );
  }
  if (entering) {
    const tryUnlock = () => {
      if (pin === data.adminPin) {
        setAdminMode(true);
        setEntering(false);
        setErr("");
        setPin("");
      } else {
        setErr("Wrong PIN");
      }
    };
    return (
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && tryUnlock()}
          placeholder="Admin PIN"
          className="bg-white border border-stone-300 rounded-lg px-3 py-1.5 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-violet-600/50"
        />
        <button onClick={tryUnlock} className="bg-stone-200 hover:bg-stone-300 border border-stone-300 rounded-lg px-3 py-1.5 font-medium">Unlock</button>
        <button onClick={() => { setEntering(false); setErr(""); }} className="text-stone-500 hover:text-stone-700"><X size={16} /></button>
        {err && <span className="text-rose-600 text-xs">{err}</span>}
      </div>
    );
  }
  return (
    <button
      onClick={() => setEntering(true)}
      className="flex items-center gap-1.5 border border-stone-300 text-stone-700 hover:border-stone-400 rounded-lg px-3 py-1.5 font-medium"
    >
      <ShieldCheck size={14} /> Admin mode
    </button>
  );
}

function LockedAdminNotice() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 text-stone-500 gap-2">
      <Lock size={28} className="text-stone-400" />
      <p className="font-medium">Admin mode is off.</p>
      <p className="text-sm max-w-sm">Unlock it with the PIN above to manage fixtures, enter outcomes, or edit scoring rules.</p>
    </div>
  );
}

function TabButton({ icon: Icon, label, active, onClick, accent }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
        !active && "border-transparent text-stone-300 hover:text-white"
      )}
      style={active ? { borderColor: accent ?? "#FBBF24", color: accent ?? "#FBBF24" } : undefined}
    >
      <Icon size={16} /> {label}
    </button>
  );
}

// Shared tab nav + content switcher — used both by the normal logged-in app
// (with Submit available, viewerId set to the logged-in contestant) and by
// the PIN-only "admin access" panel on the login screen (no Submit tab,
// since there's no contestant identity there, but everything else — the
// Matrix, Standings, Profiles, Stats and Admin panel itself — is the same).
function AppTabs({ league, leagueKey, data, persist, submitPredictions, viewerId, adminMode, now, snapshots, onRestoreSnapshot, allowSubmit }) {
  const [tab, setTab] = useState(allowSubmit ? "submit" : "matrix");
  const accent = leagueAccent(leagueKey);
  return (
    <>
      <nav style={{ background: "#3D1F5C" }} className="border-b border-white/10 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex gap-1 overflow-x-auto">
          {allowSubmit && <TabButton icon={Send} label="Submit" active={tab === "submit"} onClick={() => setTab("submit")} accent={accent} />}
          <TabButton icon={BarChart3} label="Predictions Matrix" active={tab === "matrix"} onClick={() => setTab("matrix")} accent={accent} />
          <TabButton icon={Calendar} label="Fixture List" active={tab === "fixtures"} onClick={() => setTab("fixtures")} accent={accent} />
          {adminMode && <TabButton icon={Settings2} label="Outcomes & Admin" active={tab === "admin"} onClick={() => setTab("admin")} accent={accent} />}
          <TabButton icon={Trophy} label="Standings" active={tab === "leaderboard"} onClick={() => setTab("leaderboard")} accent={accent} />
          <TabButton icon={UserCircle2} label="Profiles" active={tab === "profiles"} onClick={() => setTab("profiles")} accent={accent} />
          <TabButton icon={TrendingUp} label="Stats" active={tab === "stats"} onClick={() => setTab("stats")} accent={accent} />
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {allowSubmit && tab === "submit" && (
          <SubmitView league={league} leagueKey={leagueKey} data={data} viewerId={viewerId} submitPredictions={submitPredictions} persist={persist} now={now} />
        )}
        {tab === "matrix" && (
          <MatrixView league={league} data={data} viewerId={viewerId} adminMode={adminMode} now={now} />
        )}
        {tab === "fixtures" && <FixtureListView league={league} viewerId={viewerId} />}
        {tab === "admin" && (
          adminMode
            ? <AdminView league={league} leagueKey={leagueKey} data={data} persist={persist} snapshots={snapshots} onRestoreSnapshot={onRestoreSnapshot} now={now} />
            : <LockedAdminNotice />
        )}
        {tab === "leaderboard" && <LeaderboardView league={league} leagueKey={leagueKey} data={data} />}
        {tab === "profiles" && <ProfilesView league={league} leagueKey={leagueKey} data={data} viewerId={viewerId} adminMode={adminMode} persist={persist} />}
        {tab === "stats" && <StatsView league={league} leagueKey={leagueKey} data={data} />}
      </main>
    </>
  );
}

// Live ticking countdown to a matchday's prediction deadline. Ticks every
// second on its own local timer (the app-wide clock only ticks every 30s,
// too coarse for a countdown), warming from grey to amber inside 24h to
// red inside the final hour.
function DeadlineCountdown({ closeAt }) {
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(closeAt).getTime() - tick;
  if (ms <= 0) {
    return <span className="text-rose-600 font-mono-num text-xs font-semibold flex items-center gap-1"><Lock size={11} /> Predictions closed</span>;
  }
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const text = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${String(sec).padStart(2, "0")}s` : `${m}m ${String(sec).padStart(2, "0")}s`;
  const tone = ms < 60 * 60 * 1000 ? "text-rose-600" : ms < 24 * 60 * 60 * 1000 ? "text-amber-600" : "text-stone-600";
  return (
    <span className={cx("font-mono-num text-xs font-semibold flex items-center gap-1", tone)}>
      <Clock size={11} /> Predictions close in {text}
    </span>
  );
}

// -----------------------------------------------------------------------------
// SUBMIT VIEW
// -----------------------------------------------------------------------------
function SubmitView({ league, leagueKey, data, viewerId, submitPredictions, persist, now }) {
  const [draft, setDraft] = useState({});
  const [customDraft, setCustomDraft] = useState({}); // matchdayId -> { home, away }
  const [bonanzaDraft, setBonanzaDraft] = useState({}); // "matchdayId__slot" -> { home, away }
  const [editingCustom, setEditingCustom] = useState({}); // matchdayId -> true while re-picking the free match
  const [editingBonanza, setEditingBonanza] = useState({}); // "matchdayId__slot" -> true while re-picking
  const [confirmation, setConfirmation] = useState(null);
  const [error, setError] = useState("");

  const openMatchdays = league.matchdays.filter((md) => matchdayDisplayStatus(md, false, now) === "open");
  const participant = league.participants.find((p) => p.id === viewerId);

  useEffect(() => {
    const next = {};
    openMatchdays.forEach((md) =>
      (viewerId ? effectiveMatchesFor(md, viewerId) : md.matches).forEach((m) => {
        const existing = data.predictions[`${m.id}__${viewerId}`];
        next[m.id] = existing ? { home: String(existing.home), away: String(existing.away) } : { home: "", away: "" };
      })
    );
    setDraft(next);
    setConfirmation(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerId, league]);

  const setField = (matchId, side, val) => {
    setDraft((d) => ({ ...d, [matchId]: { ...d[matchId], [side]: val } }));
    setConfirmation(null); // editing anything retires the "saved" banner until Save is pressed again
  };

  const validPair = (pair) =>
    pair && pair.home !== "" && pair.away !== "" && Number(pair.home) >= 0 && Number(pair.away) >= 0 &&
    Number.isInteger(Number(pair.home)) && Number.isInteger(Number(pair.away));

  const submitMatch = async (md, matchId) => {
    if (!viewerId) { setError("You're not registered in this league, so this can't be saved."); return; }
    if (isPredictionsClosed(md)) { setError(`Predictions have closed for ${md.label}.`); return; }
    const pair = draft[matchId];
    if (!validPair(pair)) { setError("Enter a whole-number score for both teams."); return; }
    setError("");
    const ok = await submitPredictions({
      [`${matchId}__${viewerId}`]: { home: Number(pair.home), away: Number(pair.away), submittedAt: new Date().toISOString() },
    });
    if (ok) setConfirmation("Prediction saved.");
  };

  const submitMatchday = async (md) => {
    if (!viewerId) { setError("You're not registered in this league, so this can't be saved."); return; }
    if (isPredictionsClosed(md)) { setError(`Predictions have closed for ${md.label}.`); return; }
    const matches = effectiveMatchesFor(md, viewerId);
    const bad = matches.some((m) => !validPair(draft[m.id]));
    if (bad) { setError(`Fill in a score for all 3 matches in ${md.label} first.`); return; }
    setError("");
    const newEntries = {};
    matches.forEach((m) => {
      const pair = draft[m.id];
      newEntries[`${m.id}__${viewerId}`] = { home: Number(pair.home), away: Number(pair.away), submittedAt: new Date().toISOString() };
    });
    const ok = await submitPredictions(newEntries);
    if (ok) setConfirmation(`Submitted all 3 predictions for ${md.label}.`);
  };

  // Saves (or CHANGES) the free-selection match. Changeable right up until
  // admin locks the matchday — a matchday only appears on this tab while
  // it's open, so anything visible here is still fair game. Custom-match
  // ids are deterministic (unlike Bonanza picks), so when the teams change
  // the old prediction is explicitly cleared — otherwise a scoreline typed
  // against the old fixture would silently apply to the new one.
  const saveCustomMatch = async (md) => {
    if (isPredictionsClosed(md)) { setError(`Predictions have closed for ${md.label}.`); return; }
    const draftEntry = customDraft[md.id] || { home: "", away: "" };
    if (!draftEntry.home.trim() || !draftEntry.away.trim()) { setError("Enter both team names for your own match."); return; }
    setError("");
    const prev = md.customMatches?.[viewerId];
    const teamsChanged = prev && (prev.home !== draftEntry.home.trim() || prev.away !== draftEntry.away.trim());
    const nextMatchdays = league.matchdays.map((m) =>
      m.id === md.id
        ? { ...m, customMatches: { ...(m.customMatches || {}), [viewerId]: { home: draftEntry.home.trim(), away: draftEntry.away.trim(), outcome: null } } }
        : m
    );
    const staleKey = `custom__${md.id}__${viewerId}__${viewerId}`;
    const nextPredictions = teamsChanged
      ? Object.fromEntries(Object.entries(data.predictions).filter(([k]) => k !== staleKey))
      : data.predictions;
    const ok = await persist({ ...data, predictions: nextPredictions, leagues: { ...data.leagues, [leagueKey]: { ...league, matchdays: nextMatchdays } } });
    if (ok) setEditingCustom((e) => ({ ...e, [md.id]: false }));
  };

  // Saves (or CHANGES) one Bonanza pick (one slot) — changeable right up
  // until admin locks the matchday, same as the free-selection match. Each
  // pick gets a unique id stamped now, so a prediction made against a
  // previous pick is orphaned automatically and can never bleed onto the
  // replacement.
  const saveBonanzaPick = async (md, slotIdx) => {
    if (isPredictionsClosed(md)) { setError(`Predictions have closed for ${md.label}.`); return; }
    const key = `${md.id}__${slotIdx}`;
    const draftEntry = bonanzaDraft[key] || { home: "", away: "" };
    if (!draftEntry.home.trim() || !draftEntry.away.trim()) { setError("Enter both team names for your pick."); return; }
    setError("");
    const nextMatchdays = league.matchdays.map((m) => {
      if (m.id !== md.id) return m;
      const allPicks = { ...(m.bonanzaPicks || {}) };
      allPicks[viewerId] = {
        ...(allPicks[viewerId] || {}),
        [slotIdx]: {
          id: `bonanza__${md.id}__${viewerId}__${slotIdx}__${Date.now()}`,
          home: draftEntry.home.trim(),
          away: draftEntry.away.trim(),
          outcome: null,
        },
      };
      return { ...m, bonanzaPicks: allPicks };
    });
    const ok = await persist({ ...data, leagues: { ...data.leagues, [leagueKey]: { ...league, matchdays: nextMatchdays } } });
    if (ok) setEditingBonanza((e) => ({ ...e, [key]: false }));
  };

  return (
    <div className="space-y-6">
      {!viewerId && (
        <div className="flex items-center gap-2 bg-amber-400/10 border border-amber-400/30 text-amber-300 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={16} /> You're not a registered contestant in {league.name}, so you can look around but not submit here.
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-rose-50 border border-rose-300/30 text-rose-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {confirmation && (
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-300/30 text-emerald-700 text-sm rounded-lg px-3 py-2">
          <CheckCircle2 size={16} /> {confirmation}
        </div>
      )}

      {openMatchdays.length === 0 && (
        <p className="text-stone-500 text-sm">No matchdays are currently open for predictions in {league.name}.</p>
      )}

      {openMatchdays.map((md) => {
        const myPairing = viewerId && md.pairings ? md.pairings.pairings.find((p) => p.home === viewerId || p.away === viewerId) : null;
        const opponentId = myPairing ? (myPairing.home === viewerId ? myPairing.away : myPairing.home) : null;
        const opponentName = opponentId ? league.participants.find((p) => p.id === opponentId)?.name : null;
        const isBye = viewerId && md.pairings?.bye === viewerId;
        const hostId = myPairing ? myPairing.home : null;
        const hostStadium = hostId ? league.participants.find((p) => p.id === hostId)?.stadium : null;
        const hasFreeSlot = !md.bonanza && md.freeMatchIndex !== null && md.freeMatchIndex !== undefined;
        const bonanzaSlots = viewerId ? bonanzaSlotsFor(md, viewerId) : null; // null unless this is a Bonanza matchday I'm part of
        // What each Bonanza slot allows, per the league rules: home
        // contestants outside the Premier League get one any-division slot
        // (Match 3); every other free slot is a Premier League match.
        const bonanzaRuleFor = (slotIdx) =>
          leagueKey !== "league1" && slotIdx === 2
            ? "Any match of your choice, from the Premier League down to the National League."
            : "Any Premier League match of your choice.";
        const isHomeInPairing = myPairing && myPairing.home === viewerId;
        const myCustomMatch = myPairing ? md.customMatches?.[myPairing.home] : null;
        const matches = viewerId ? effectiveMatchesFor(md, viewerId) : md.matches;
        const cDraft = customDraft[md.id] || { home: "", away: "" };
        // Every match saved AND untouched since saving — drives the
        // submit-all button's "done" state below. Editing any scoreline
        // makes this false again, so the button reverts automatically.
        const allSaved = !!viewerId && matches.length > 0 && matches.every((m) => {
          const stored = data.predictions[`${m.id}__${viewerId}`];
          const p = draft[m.id];
          return !!stored && !!p && String(stored.home) === p.home && String(stored.away) === p.away;
        });
        return (
        <section key={md.id} className="bg-white border border-stone-200 rounded-2xl p-5">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
            <h2 className="font-display font-semibold text-lg flex items-center gap-2">
              {md.label}
              {md.scheduledDate && <span className="text-xs font-normal normal-case text-violet-700 flex items-center gap-1"><Calendar size={12} /> {fmtDateOnly(md.scheduledDate)}</span>}
            </h2>
            <div className="flex flex-col items-end gap-1">
              <span className="text-xs text-stone-500 flex items-center gap-1"><Calendar size={13} /> reveals {fmtDateTime(md.releaseAt)}</span>
              {md.predictionsCloseAt && <DeadlineCountdown closeAt={md.predictionsCloseAt} />}
            </div>
          </div>
          {(opponentName || isBye) && (
            <p className="text-xs text-amber-300 mb-4 flex items-center gap-1">
              <Trophy size={12} /> {isBye ? "You have a bye this matchday — automatic win." : `Head-to-head this matchday: vs ${opponentName}`}
              {hostStadium && <span className="text-stone-500 flex items-center gap-1">· <Landmark size={11} /> {hostStadium}</span>}
            </p>
          )}
          {!opponentName && !isBye && <div className="mb-4" />}
          {bonanzaSlots && (
            <div className="flex items-start gap-2 bg-amber-400/10 border border-amber-400/30 text-amber-700 text-sm rounded-lg px-3 py-2.5 mb-4">
              <Sparkles size={16} className="shrink-0 mt-0.5 text-amber-500" />
              <span>
                <strong className="font-display">Bonanza matchday!</strong>{" "}
                {bonanzaSlots.length === 3
                  ? (leagueKey === "league1"
                      ? "You're at home — pick any 3 Premier League matches to predict."
                      : "You're at home — pick 2 Premier League matches, plus Match 3 from any division (Premier League down to the National League).")
                  : "Pick any 2 Premier League matches to predict — Match 3 is set for you below."}
                {" "}You can change any of your picks right up until predictions close for this matchday.
              </span>
            </div>
          )}
          <div className="space-y-3">
            {matches.map((m, idx) => {
              const isFreeSlot = hasFreeSlot && idx === md.freeMatchIndex && isHomeInPairing;
              const isBonanzaSlot = bonanzaSlots ? bonanzaSlots.includes(idx) : false;
              const bonanzaPickSet = isBonanzaSlot && !!md.bonanzaPicks?.[viewerId]?.[idx];

              // Bonanza: a free slot without a saved pick yet — or one the
              // contestant is changing their mind about — shows the
              // per-slot picker instead of a prediction row. Once the pick
              // is saved it becomes a normal prediction row (with the
              // chosen teams) via effectiveMatchesFor.
              if (isBonanzaSlot && (!bonanzaPickSet || editingBonanza[`${md.id}__${idx}`])) {
                const bKey = `${md.id}__${idx}`;
                const bDraft = bonanzaDraft[bKey] || { home: "", away: "" };
                return (
                  <div key={`bonanza-${md.id}-${idx}`} className="border border-amber-400/30 bg-amber-400/5 rounded-xl p-4 space-y-2">
                    <div className="text-xs font-semibold text-amber-300 uppercase tracking-wide flex items-center gap-1.5"><Sparkles size={12} /> Match {idx + 1} — your Bonanza pick</div>
                    <p className="text-[11px] text-stone-500">{bonanzaRuleFor(idx)}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={bDraft.home}
                        onChange={(e) => setBonanzaDraft((d) => ({ ...d, [bKey]: { ...bDraft, home: e.target.value } }))}
                        placeholder="Home team"
                        className="flex-1 min-w-[120px] bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
                      />
                      <span className="text-stone-500 text-xs">v</span>
                      <input
                        value={bDraft.away}
                        onChange={(e) => setBonanzaDraft((d) => ({ ...d, [bKey]: { ...bDraft, away: e.target.value } }))}
                        placeholder="Away team"
                        className="flex-1 min-w-[120px] bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
                      />
                      <button onClick={() => saveBonanzaPick(md, idx)} className="bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-3 py-2 text-sm shrink-0">
                        Set match
                      </button>
                      {bonanzaPickSet && (
                        <button onClick={() => setEditingBonanza((e) => ({ ...e, [bKey]: false }))} className="text-sm text-stone-500 hover:text-stone-900 px-2 shrink-0">
                          Cancel
                        </button>
                      )}
                    </div>
                    {bonanzaPickSet && (
                      <p className="text-[11px] text-stone-500">Changing your pick clears any scoreline you'd already entered for the old one — you'll predict the new match fresh.</p>
                    )}
                  </div>
                );
              }

              // The home contestant hasn't chosen their own match yet — or
              // is changing their mind — so show the picker instead of a
              // normal prediction row. Their opponent always sees the
              // admin's pre-determined match here, unaffected by this — so
              // this branch only ever applies to the home contestant.
              if (isFreeSlot && (!myCustomMatch || editingCustom[md.id])) {
                return (
                  <div key={`free-${md.id}`} className="border border-amber-400/30 bg-amber-400/5 rounded-xl p-4 space-y-2">
                    <div className="text-xs font-semibold text-amber-300 uppercase tracking-wide flex items-center gap-1.5"><Landmark size={12} /> Your home match — pick your own</div>
                    <p className="text-[11px] text-stone-500">
                      {leagueKey === "league1"
                        ? "You can only change this match to another Premier League match."
                        : "You can change this match to any match from the Premier League down to the National League."}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={cDraft.home}
                        onChange={(e) => setCustomDraft((d) => ({ ...d, [md.id]: { ...cDraft, home: e.target.value } }))}
                        placeholder="Home team"
                        className="flex-1 min-w-[120px] bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
                      />
                      <span className="text-stone-500 text-xs">v</span>
                      <input
                        value={cDraft.away}
                        onChange={(e) => setCustomDraft((d) => ({ ...d, [md.id]: { ...cDraft, away: e.target.value } }))}
                        placeholder="Away team"
                        className="flex-1 min-w-[120px] bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
                      />
                      <button onClick={() => saveCustomMatch(md)} className="bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-3 py-2 text-sm shrink-0">
                        Set match
                      </button>
                      {myCustomMatch && (
                        <button onClick={() => setEditingCustom((e) => ({ ...e, [md.id]: false }))} className="text-sm text-stone-500 hover:text-stone-900 px-2 shrink-0">
                          Cancel
                        </button>
                      )}
                    </div>
                    {myCustomMatch && (
                      <p className="text-[11px] text-stone-500">Changing your match clears any scoreline you'd already entered for the old one — you'll predict the new match fresh.</p>
                    )}
                  </div>
                );
              }

              const stored = viewerId ? data.predictions[`${m.id}__${viewerId}`] : null;
              const pair = draft[m.id] || { home: "", away: "" };
              // "submitted" shows only while the boxes still hold exactly
              // what's saved — the moment a scoreline is edited, the tick
              // vanishes until Save is pressed again.
              const already = !!stored && String(stored.home) === pair.home && String(stored.away) === pair.away;
              return (
                <div key={m.id} className="border border-stone-200 rounded-xl p-4 bg-white">
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                    <div className="text-xs text-stone-500 flex items-center gap-1">
                      {(isFreeSlot || bonanzaPickSet) ? (
                        <>
                          <Landmark size={12} /> Your own match
                          {isFreeSlot && (
                            <button
                              onClick={() => { setCustomDraft((d) => ({ ...d, [md.id]: { home: m.home, away: m.away } })); setEditingCustom((e) => ({ ...e, [md.id]: true })); }}
                              className="text-violet-700 hover:underline ml-1"
                            >
                              Change match
                            </button>
                          )}
                          {bonanzaPickSet && (
                            <button
                              onClick={() => { setBonanzaDraft((d) => ({ ...d, [`${md.id}__${idx}`]: { home: m.home, away: m.away } })); setEditingBonanza((e) => ({ ...e, [`${md.id}__${idx}`]: true })); }}
                              className="text-violet-700 hover:underline ml-1"
                            >
                              Change pick
                            </button>
                          )}
                        </>
                      ) : <><Clock size={12} /> {fmtDateTime(m.kickoff)}</>}
                    </div>
                    {already && <span className="text-xs text-emerald-700 flex items-center gap-1 font-medium"><CheckCircle2 size={13} /> submitted</span>}
                  </div>
                  {/* Phones: two stacked rows (full team name + its score box),
                      so long names never truncate. Larger screens: the
                      original single centred line, via sm: order classes. */}
                  <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 sm:flex sm:justify-center">
                    <span className="min-w-0 font-medium sm:order-1 sm:flex-1 sm:text-right">{m.home}</span>
                    <span className="sm:order-2"><ScoreInput value={pair.home} onChange={(v) => setField(m.id, "home", v)} /></span>
                    <span className="hidden sm:inline text-stone-500 font-mono-num sm:order-3">–</span>
                    <span className="min-w-0 font-medium sm:order-5 sm:flex-1 sm:text-left">{m.away}</span>
                    <span className="sm:order-4"><ScoreInput value={pair.away} onChange={(v) => setField(m.id, "away", v)} /></span>
                  </div>
                  <div className="flex justify-end mt-3">
                    <button onClick={() => submitMatch(md, m.id)} className="bg-stone-200 hover:bg-stone-300 border border-stone-300 rounded-lg px-3 py-1.5 text-sm font-medium">Save</button>
                  </div>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => submitMatchday(md)}
            disabled={allSaved}
            className={cx(
              "mt-4 w-full sm:w-auto flex items-center justify-center gap-2 font-semibold rounded-lg px-5 py-2.5 text-sm",
              allSaved ? "bg-stone-300 text-stone-600 cursor-default" : "bg-violet-700 hover:bg-violet-600 text-white"
            )}
          >
            {allSaved ? <><CheckCircle2 size={16} /> Predictions Submitted</> : <><Send size={16} /> Submit all 3 for {md.label}</>}
          </button>
        </section>
        );
      })}
    </div>
  );
}

function ScoreInput({ value, onChange }) {
  return (
    <input
      type="number"
      min="0"
      step="1"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-14 text-center bg-white border border-stone-300 rounded-lg px-2 py-1.5 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-violet-600/50"
    />
  );
}

// -----------------------------------------------------------------------------
// MATRIX VIEW — respects the reveal date
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// FIXTURE LIST — the whole season's head-to-head schedule, visible to every
// contestant so they can see who they're facing every matchday, including
// rounds that haven't happened yet. Cross-references real matchdays where
// they exist (for status/label); rounds with no matchday yet still show
// the pairing on its own.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// HONOURS & HISTORY — global pages, deliberately separate from the
// division-scoped tabs. Both are built entirely from data.seasonArchives,
// so they need nothing extra tracked season to season — ending a season
// (see endSeason()) already captures everything they need.
// -----------------------------------------------------------------------------
// Given a legacy honour entry, resolves the winner's live name/badge from
// the current roster if it's linked to one (so a badge update later still
// shows correctly here), falling back to the plain text originally entered
// if it isn't linked, or the linked contestant no longer exists.
function resolveLegacyWinner(entry, data) {
  if (entry.linkedParticipantId) {
    for (const league of Object.values(data.leagues)) {
      const p = league.participants.find((x) => x.id === entry.linkedParticipantId);
      if (p) return { name: p.name, badge: p.badge || null };
    }
  }
  return { name: entry.winnerName, badge: null };
}

function LegacyHonourForm({ data, onAdd, onCancel }) {
  const [competition, setCompetition] = useState("");
  const [season, setSeason] = useState("");
  const [winnerName, setWinnerName] = useState("");
  const [linkedId, setLinkedId] = useState("");

  const allParticipants = Object.entries(data.leagues).flatMap(([key, league]) =>
    league.participants.map((p) => ({ id: p.id, name: p.name, leagueName: league.name, leagueKey: key }))
  );

  const handleLinkChange = (id) => {
    setLinkedId(id);
    const match = allParticipants.find((p) => p.id === id);
    if (match) setWinnerName(match.name);
  };

  const submit = () => {
    if (!competition.trim() || !season.trim() || !winnerName.trim()) return;
    onAdd({
      id: `legacy_${Date.now()}`,
      competition: competition.trim(),
      season: season.trim(),
      winnerName: winnerName.trim(),
      linkedParticipantId: linkedId || null,
    });
    setCompetition(""); setSeason(""); setWinnerName(""); setLinkedId("");
  };

  return (
    <div className="border border-amber-400/30 bg-amber-400/5 rounded-2xl p-4 space-y-3">
      <h4 className="font-display font-semibold text-sm">Add a legacy honour</h4>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-stone-500">Tournament / competition name</label>
          <input value={competition} onChange={(e) => setCompetition(e.target.value)} placeholder="e.g. Premier League" className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <div>
          <label className="text-xs text-stone-500">Season</label>
          <input value={season} onChange={(e) => setSeason(e.target.value)} placeholder="e.g. 2011/12" className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <div>
          <label className="text-xs text-stone-500">Link to a current contestant (optional)</label>
          <select value={linkedId} onChange={(e) => handleLinkChange(e.target.value)} className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50">
            <option value="">— not on the current roster —</option>
            {allParticipants.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.leagueName})</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-stone-500">Winner's name</label>
          <input value={winnerName} onChange={(e) => setWinnerName(e.target.value)} placeholder="Winner name" className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          <span className="text-[11px] text-stone-500">Auto-filled when you link a contestant above — edit freely if they're not on the roster.</span>
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={submit} className="bg-amber-400 hover:bg-amber-300 text-black font-semibold rounded-lg px-4 py-2 text-sm">Add honour</button>
        <button onClick={onCancel} className="text-sm text-stone-500 hover:text-stone-900 px-2">Close</button>
      </div>
    </div>
  );
}

function HonoursView({ data, adminMode, persist }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const visibleArchives = [...data.seasonArchives].filter((s) => adminMode || !s.hidden).reverse(); // most recent season first
  const legacyHonours = [...(data.legacyHonours || [])].sort((a, b) => {
    const ya = parseInt((a.season.match(/\d{4}/) || ["0"])[0], 10);
    const yb = parseInt((b.season.match(/\d{4}/) || ["0"])[0], 10);
    return yb - ya;
  });

  const addLegacyHonour = async (entry) => {
    await persist({ ...data, legacyHonours: [...(data.legacyHonours || []), entry] });
    setShowAddForm(false);
  };
  const removeLegacyHonour = async (id) => {
    await persist({ ...data, legacyHonours: (data.legacyHonours || []).filter((h) => h.id !== id) });
  };
  const toggleSeasonHidden = async (seasonId) => {
    const nextArchives = data.seasonArchives.map((s) => (s.id === seasonId ? { ...s, hidden: !s.hidden } : s));
    await persist({ ...data, seasonArchives: nextArchives });
  };
  const deleteSeasonArchive = async (seasonId) => {
    const nextArchives = data.seasonArchives.filter((s) => s.id !== seasonId);
    await persist({ ...data, seasonArchives: nextArchives });
    setPendingDeleteId(null);
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-display font-semibold text-lg flex items-center gap-2"><Trophy size={18} className="text-amber-400" /> Honours</h2>
        <p className="text-xs text-stone-500">Champions and podium finishers from every completed season, across every division.</p>
      </div>

      {visibleArchives.length === 0 ? (
        <p className="text-stone-500 text-sm">No seasons have been completed on this site yet — this section fills in once a season ends.</p>
      ) : (
        visibleArchives.map((season) => (
          <div key={season.id} className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h3 className="font-display font-semibold text-sm text-violet-800">
                {season.label} <span className="text-stone-400 font-normal normal-case">ended {fmtDateTime(season.endedAt)}</span>
                {season.hidden && <span className="ml-2 text-[10px] uppercase tracking-wide text-stone-400 border border-stone-300 rounded-full px-2 py-0.5">Hidden from contestants</span>}
              </h3>
              {adminMode && pendingDeleteId !== season.id && (
                <div className="flex items-center gap-3 text-xs">
                  <button onClick={() => toggleSeasonHidden(season.id)} className="text-stone-500 hover:text-stone-900 flex items-center gap-1">
                    {season.hidden ? <><Eye size={12} /> Unhide</> : <><EyeOff size={12} /> Hide</>}
                  </button>
                  <button onClick={() => setPendingDeleteId(season.id)} className="text-stone-500 hover:text-rose-600 flex items-center gap-1">
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              )}
            </div>
            {pendingDeleteId === season.id && (
              <div className="flex items-center gap-2 bg-rose-50 border border-rose-300/40 rounded-lg px-3 py-2">
                <span className="text-xs text-rose-700">Permanently delete {season.label}'s honours record? This can't be undone — it won't affect anything else, just this entry.</span>
                <button onClick={() => deleteSeasonArchive(season.id)} className="ml-auto text-xs bg-rose-600 hover:bg-rose-500 text-white font-semibold rounded px-2 py-1 shrink-0">Yes, delete</button>
                <button onClick={() => setPendingDeleteId(null)} className="text-xs text-stone-500 hover:text-stone-900 shrink-0">Cancel</button>
              </div>
            )}
            <div className="grid sm:grid-cols-2 gap-4">
              {Object.values(season.leagues).map((leagueArchive) => {
                const badgeById = Object.fromEntries(leagueArchive.participants.map((p) => [p.id, p.badge]));
                const podium = leagueArchive.finalStandings.slice(0, 3);
                return (
                  <div key={leagueArchive.name} className="border border-stone-200 rounded-2xl bg-white overflow-hidden">
                    <div style={{ background: "#3D1F5C" }} className="px-4 py-2">
                      <span className="font-display font-semibold text-sm text-amber-300">{leagueArchive.name}</span>
                    </div>
                    <div className="p-4 space-y-3">
                      {podium.length === 0 && <p className="text-xs text-stone-400">No results recorded.</p>}
                      {podium.map((row, i) => (
                        <div key={row.id} className="flex items-center gap-3">
                          {i === 0 ? <Crown size={18} className="text-amber-400 shrink-0" /> : <Medal size={18} className={cx("shrink-0", i === 1 ? "text-stone-400" : "text-orange-400")} />}
                          {badgeById[row.id] ? (
                            <img src={badgeById[row.id]} alt="" className="w-7 h-7 rounded-full border border-stone-200 object-contain shrink-0" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-stone-100 border border-stone-200 shrink-0" />
                          )}
                          <span className="font-medium flex-1 truncate">{row.name}</span>
                          <span className="text-xs font-mono-num text-stone-500">{row.leaguePoints ?? row.totalPoints} pts</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}

      <div className="space-y-3 border-t border-stone-200 pt-6">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-display font-semibold text-sm text-stone-600">Before this site — prior honours</h3>
          {adminMode && !showAddForm && (
            <button onClick={() => setShowAddForm(true)} className="flex items-center gap-1.5 text-xs bg-stone-200 hover:bg-stone-300 rounded-lg px-3 py-1.5 font-medium">
              <Plus size={13} /> Add legacy honour
            </button>
          )}
        </div>

        {adminMode && showAddForm && <LegacyHonourForm data={data} onAdd={addLegacyHonour} onCancel={() => setShowAddForm(false)} />}

        {legacyHonours.length === 0 ? (
          <p className="text-xs text-stone-500">No honours recorded from before this site yet{adminMode ? " — add them above." : "."}</p>
        ) : (
          <div className="border border-stone-200 rounded-2xl bg-white overflow-hidden">
            <table className="min-w-full text-sm">
              <tbody>
                {legacyHonours.map((entry) => {
                  const winner = resolveLegacyWinner(entry, data);
                  return (
                    <tr key={entry.id} className="border-t border-stone-100 first:border-t-0">
                      <td className="px-4 py-2.5 font-mono-num text-stone-400 w-24">{entry.season}</td>
                      <td className="px-4 py-2.5 text-stone-700">{entry.competition}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {winner.badge ? (
                            <img src={winner.badge} alt="" className="w-5 h-5 rounded-full border border-stone-200 object-contain shrink-0" />
                          ) : (
                            <Crown size={14} className="text-amber-400 shrink-0" />
                          )}
                          <span className="font-medium">{winner.name}</span>
                        </div>
                      </td>
                      {adminMode && (
                        <td className="px-4 py-2.5 text-right">
                          <button onClick={() => removeLegacyHonour(entry.id)} className="text-stone-400 hover:text-rose-600"><X size={14} /></button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryView({ data, adminMode, persist }) {
  const [editing, setEditing] = useState(false);
  const [textDraft, setTextDraft] = useState(data.historyPage.text);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState("");
  const fileInputRef = useRef(null);
  const MAX_HISTORY_IMAGES = 30; // a comfortable safety margin so this page's storage bucket stays a sensible size

  const saveText = async () => {
    await persist({ ...data, historyPage: { ...data.historyPage, text: textDraft } });
    setEditing(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const addImage = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (data.historyPage.images.length >= MAX_HISTORY_IMAGES) {
      setImageError(`This page is capped at ${MAX_HISTORY_IMAGES} photos to keep it a sensible size — remove one before adding another.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setImageError("");
    setUploading(true);
    try {
      const url = await resizeImageFile(file, 640);
      const nextImages = [...data.historyPage.images, { id: `hist_${Date.now()}`, url, caption: "" }];
      await persist({ ...data, historyPage: { ...data.historyPage, images: nextImages } });
    } catch {
      /* best-effort — a failed image shouldn't break the page */
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const setCaption = async (id, caption) => {
    const nextImages = data.historyPage.images.map((img) => (img.id === id ? { ...img, caption } : img));
    await persist({ ...data, historyPage: { ...data.historyPage, images: nextImages } });
  };

  const removeImage = async (id) => {
    const nextImages = data.historyPage.images.filter((img) => img.id !== id);
    await persist({ ...data, historyPage: { ...data.historyPage, images: nextImages } });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-display font-semibold text-lg flex items-center gap-2"><History size={18} className="text-amber-400" /> History</h2>
          <p className="text-xs text-stone-500">The story of the competition, in Admin's own words.</p>
        </div>
        {adminMode && !editing && (
          <button onClick={() => { setTextDraft(data.historyPage.text); setEditing(true); }} className="flex items-center gap-1.5 text-xs bg-stone-200 hover:bg-stone-300 rounded-lg px-3 py-1.5 font-medium">
            <UserCircle2 size={13} /> Edit text
          </button>
        )}
      </div>

      <div className="border border-stone-200 rounded-2xl bg-white p-5">
        {editing ? (
          <div className="space-y-3">
            <textarea
              value={textDraft}
              onChange={(e) => setTextDraft(e.target.value)}
              rows={14}
              placeholder="Write the history of the competition here…"
              className="w-full bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-violet-600/50"
            />
            <div className="flex gap-2">
              <button onClick={saveText} className="flex items-center gap-2 bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-4 py-2 text-sm">
                {saved ? <CheckCircle2 size={16} /> : null} Save
              </button>
              <button onClick={() => setEditing(false)} className="text-sm text-stone-500 hover:text-stone-900 px-2">Cancel</button>
            </div>
          </div>
        ) : data.historyPage.text.trim() ? (
          <p className="text-sm text-stone-800 leading-relaxed whitespace-pre-line">{data.historyPage.text}</p>
        ) : (
          <p className="text-sm text-stone-400 italic">Nothing written yet{adminMode ? " — click \"Edit text\" above to get started." : "."}</p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-display font-semibold text-sm text-stone-600">Photos</h3>
          {adminMode && (
            <>
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex items-center gap-1.5 text-xs bg-stone-200 hover:bg-stone-300 disabled:opacity-50 rounded-lg px-3 py-1.5 font-medium">
                <Camera size={13} /> {uploading ? "Uploading…" : "Add photo"}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={addImage} className="hidden" />
            </>
          )}
        </div>
        {imageError && (
          <div className="flex items-center gap-2 bg-amber-400/10 border border-amber-400/30 text-amber-700 text-sm rounded-lg px-3 py-2">
            <AlertCircle size={16} className="shrink-0" /> {imageError}
          </div>
        )}

        {data.historyPage.images.length === 0 ? (
          <p className="text-xs text-stone-500">No photos added yet{adminMode ? " — add some above to bring the history to life." : "."}</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.historyPage.images.map((img) => (
              <div key={img.id} className="border border-stone-200 rounded-2xl bg-white overflow-hidden">
                <img src={img.url} alt={img.caption || ""} className="w-full h-40 object-cover" />
                <div className="p-3 space-y-2">
                  {adminMode ? (
                    <input
                      value={img.caption}
                      onChange={(e) => setCaption(img.id, e.target.value)}
                      placeholder="Caption (optional)"
                      className="w-full bg-stone-50 border border-stone-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-violet-600/50"
                    />
                  ) : (
                    img.caption && <p className="text-xs text-stone-600">{img.caption}</p>
                  )}
                  {adminMode && (
                    <button onClick={() => removeImage(img.id)} className="text-[11px] text-stone-400 hover:text-rose-600 flex items-center gap-1">
                      <X size={11} /> Remove photo
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FixtureListView({ league, viewerId }) {
  const nameById = useMemo(() => Object.fromEntries(league.participants.map((p) => [p.id, p.name])), [league.participants]);
  const stadiumById = useMemo(() => Object.fromEntries(league.participants.map((p) => [p.id, p.stadium])), [league.participants]);
  const byId = useMemo(() => Object.fromEntries(league.participants.map((p) => [p.id, p])), [league.participants]);

  if (league.h2hSchedule.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="font-display font-semibold text-lg flex items-center gap-2"><Calendar size={18} className="text-amber-400" /> {league.name} fixture list</h2>
        <p className="text-stone-500 text-sm">The season fixture list hasn't been generated yet — check back once the admin sets it up.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="font-display font-semibold text-lg flex items-center gap-2"><Calendar size={18} className="text-amber-400" /> {league.name} fixture list</h2>
      <p className="text-xs text-stone-500">The whole season's head-to-head match-ups, matchday by matchday. Your own is highlighted. Matchdays not yet set up by the admin still show who you're due to face.</p>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {league.h2hSchedule.map((round, i) => {
          // Matchdays are always created in round order and never reordered
          // or deleted, so round i lines up directly with matchdays[i].
          const md = league.matchdays[i] && !league.matchdays[i].draft ? league.matchdays[i] : null;
          const label = md?.label ?? `Matchday ${i + 1}`;
          const statusText = md ? matchdayDisplayStatus(md) : "not yet scheduled";
          const statusStyle = md ? MATCHDAY_STATUS_STYLES[matchdayDisplayStatus(md)] : "bg-white/5 text-stone-500 border-stone-300 border-dashed";
          return (
            <div key={i} className="border border-stone-200 rounded-xl p-3 bg-white">
              <div className="flex items-center justify-between mb-1">
                <span className="font-display font-semibold text-sm">{label}</span>
                <span className={cx("text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide", statusStyle)}>
                  {statusText}
                </span>
              </div>
              <div className="text-[11px] text-violet-700 flex items-center gap-1 mb-2">
                <Calendar size={11} /> {fmtDateOnly(round.scheduledDate) ?? "Date to be confirmed"}
              </div>
              <div className="space-y-1">
                {round.pairings.map((p, j) => {
                  const mine = viewerId && (p.home === viewerId || p.away === viewerId);
                  const stadium = stadiumById[p.home];
                  return (
                    <div key={j} className={cx("text-xs rounded px-2 py-1", mine ? "bg-amber-400/10 text-amber-300 font-medium" : "text-stone-500")}>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <BadgeAvatar participant={byId[p.home]} name={nameById[p.home] ?? "?"} size={16} />
                        <span className="truncate">{nameById[p.home] ?? "?"}</span>
                        <span className="opacity-60 shrink-0">v</span>
                        <span className="truncate">{nameById[p.away] ?? "?"}</span>
                        <BadgeAvatar participant={byId[p.away]} name={nameById[p.away] ?? "?"} size={16} />
                      </div>
                      {stadium && <div className="text-[10px] opacity-70 flex items-center gap-1 mt-0.5"><Landmark size={10} /> {stadium}</div>}
                    </div>
                  );
                })}
                {round.bye && (
                  <div className={cx("text-xs rounded px-2 py-1 flex items-center gap-1.5", viewerId === round.bye ? "bg-amber-400/10 text-amber-300 font-medium" : "text-stone-500")}>
                    <span>Bye:</span>
                    <BadgeAvatar participant={byId[round.bye]} name={nameById[round.bye] ?? "?"} size={16} />
                    <span className="truncate">{nameById[round.bye] ?? "?"}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// HEAD-TO-HEAD CARDS — the pairing-first view of a matchday: one card per
// match-up, with both contestants' predictions aligned side by side,
// match by match, and the head-to-head outcome once results are published.
// This replaces the old "scan the big grid for your opponent's row"
// experience; the full grid is still available behind a toggle. Your own
// pairing is highlighted and sorted to the front. Visibility matches the
// grid: everything — normal predictions AND chosen matches (free selection
// or Bonanza picks) — hides until the reveal time, then shows in full.
// Once results are published, each prediction also shows the points it
// earned, and the card footer shows the head-to-head outcome.
// -----------------------------------------------------------------------------
function H2HPairingsPanel({ matchday, league, predictions, viewerId, adminMode, now }) {
  if (!matchday.pairings) return null;
  const released = adminMode || isReleased(matchday, now);
  const canSeeResults = adminMode || matchday.resultsPublished;
  const byId = Object.fromEntries(league.participants.map((p) => [p.id, p]));
  const h2h = canSeeResults ? computeH2HResultsForMatchday(matchday, predictions, league.participants) : null;

  // Your own pairing first, then roster order.
  const pairings = [...matchday.pairings.pairings].sort((a, b) => {
    const aMine = viewerId && (a.home === viewerId || a.away === viewerId) ? 0 : 1;
    const bMine = viewerId && (b.home === viewerId || b.away === viewerId) ? 0 : 1;
    return aMine - bMine;
  });

  const sideCell = (pid, matchIdx) => {
    const m = effectiveMatchesFor(matchday, pid)[matchIdx];
    const pred = predictions[`${m.id}__${pid}`];
    const isSelf = pid === viewerId;
    // A slot where this contestant's fixture can differ from the default:
    // the normal free slot, or their own Bonanza pick slots.
    const isFree = matchday.bonanza
      ? (bonanzaSlotsFor(matchday, pid)?.includes(matchIdx) ?? false)
      : matchday.freeMatchIndex === matchIdx;
    const isCustomPick = isFree && (m.id.startsWith("custom__") || m.id.startsWith("bonanza__"));
    // Picks follow the same reveal as scorelines: hidden before the reveal
    // time, fully visible (match and prediction) from then on.
    const canSeePick = adminMode || released || isSelf;
    const canSeeVal = released || isSelf;
    return (
      <div className="flex-1 min-w-0 text-center">
        {isCustomPick && (
          canSeePick ? (
            <div className="text-[10px] text-stone-500 leading-tight">{m.home} v {m.away}</div>
          ) : (
            <div className="text-[10px] text-stone-400 italic leading-tight flex items-center justify-center gap-1"><EyeOff size={9} /> pick hidden</div>
          )
        )}
        {isFree && !isCustomPick && (
          // A pick slot where the contestant never chose — they fall back
          // to the admin's default fixture, shown plainly.
          <div className="text-[10px] text-stone-500 leading-tight">{m.home} v {m.away}</div>
        )}
        {pred ? (
          canSeeVal
            ? <span className="font-mono-num text-sm font-semibold text-stone-900">{pred.home}–{pred.away}</span>
            : <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 font-medium"><CheckCircle2 size={10} /> submitted</span>
        ) : (
          <span className="text-[10px] text-stone-400">{isPredictionsClosed(matchday, now) ? "no pick" : "pending"}</span>
        )}
        {/* FT result for any match at a pick slot — the centre column can't
            show it there (the fixture varies per side), so each side carries
            its own. This covers chosen picks AND the default mandatory match
            an away contestant predicts at the free slot, which previously
            had no FT score anywhere on the card. */}
        {isFree && canSeeResults && m.outcome && (!isCustomPick || canSeePick) && (
          <div className="text-[10px] text-amber-500 font-mono-num">FT {m.outcome.home}–{m.outcome.away}</div>
        )}
        {/* Once results are published: the points this prediction earned on
            this match — one per side, adding up to the totals in the card's
            footer. Shown even for a missed prediction (0 pts), so the sums
            always visibly reconcile. */}
        {canSeeResults && canSeeVal && m.outcome && (
          <div className={cx("text-[10px] font-mono-num font-semibold mt-0.5", scoreMatch(m, pred, matchday.scoring).points > 0 ? "text-violet-700" : "text-stone-400")}>
            +{scoreMatch(m, pred, matchday.scoring).points} pts
          </div>
        )}
      </div>
    );
  };

  const nameOf = (pid) => byId[pid]?.name ?? "?";

  return (
    <div className="grid sm:grid-cols-2 gap-3">
      {pairings.map((pair, i) => {
        const mine = viewerId && (pair.home === viewerId || pair.away === viewerId);
        const home = byId[pair.home];
        const away = byId[pair.away];
        const result = h2h?.[pair.home];
        let resultLine = null;
        let resultTone = "text-stone-500";
        if (result && result.ownRaw !== null && result.opponentRaw !== null) {
          if (result.outcome === "draw") {
            resultLine = `Draw ${result.ownRaw}–${result.opponentRaw} · 1 pt each`;
          } else if (result.outcome === "win") {
            resultLine = `${nameOf(pair.home)} won ${result.ownRaw}–${result.opponentRaw} · 3 pts`;
            resultTone = "text-emerald-700";
          } else {
            resultLine = `${nameOf(pair.away)} won ${result.opponentRaw}–${result.ownRaw} · 3 pts`;
            resultTone = "text-emerald-700";
          }
        }
        return (
          <div key={i} className={cx("border rounded-2xl bg-white overflow-hidden", mine ? "border-amber-400/50" : "border-stone-200")}>
            <div className={cx("px-3 py-2", mine ? "bg-amber-400/10" : "bg-stone-50")}>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <BadgeAvatar participant={home} name={home?.name ?? "?"} size={26} />
                  <span className={cx("font-medium text-sm truncate", pair.home === viewerId && "text-amber-600")}>{nameOf(pair.home)}</span>
                </div>
                <span className="text-[10px] text-stone-400 font-display shrink-0">V</span>
                <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
                  <span className={cx("font-medium text-sm truncate text-right", pair.away === viewerId && "text-amber-600")}>{nameOf(pair.away)}</span>
                  <BadgeAvatar participant={away} name={away?.name ?? "?"} size={26} />
                </div>
              </div>
              {/* The home contestant's stadium — this fixture is "played" at
                  their ground, so it headlines the card like a real venue. */}
              {home?.stadium && (
                <div className="mt-1 text-[10px] text-stone-500 flex items-center justify-center gap-1">
                  <Landmark size={9} className="shrink-0" /> <span className="truncate">{home.stadium}</span>
                </div>
              )}
            </div>
            {matchday.matches.map((defaultMatch, idx) => {
              const isFree = !matchday.bonanza && matchday.freeMatchIndex === idx;
              return (
                <div key={defaultMatch.id} className="flex items-center gap-2 px-3 py-2 border-t border-stone-100">
                  {sideCell(pair.home, idx)}
                  <div className="w-20 sm:w-28 shrink-0 text-center text-[10px] text-stone-500 leading-tight">
                    {matchday.bonanza && idx < 2 ? (
                      <span className="italic flex items-center justify-center gap-1"><Sparkles size={9} /> Bonanza picks</span>
                    ) : matchday.bonanza && idx === 2 ? (
                      <>
                        <div>{defaultMatch.home}</div>
                        <div>v {defaultMatch.away}</div>
                        <div className="italic text-stone-400">anchor — home picks own</div>
                        {defaultMatch.outcome && canSeeResults && (
                          <div className="text-amber-500 font-mono-num">FT {defaultMatch.outcome.home}–{defaultMatch.outcome.away}</div>
                        )}
                      </>
                    ) : isFree ? (
                      <span className="italic flex items-center justify-center gap-1"><Landmark size={9} /> Free match</span>
                    ) : (
                      <>
                        <div>{defaultMatch.home}</div>
                        <div>v {defaultMatch.away}</div>
                        {defaultMatch.outcome && canSeeResults && (
                          <div className="text-amber-500 font-mono-num">FT {defaultMatch.outcome.home}–{defaultMatch.outcome.away}</div>
                        )}
                      </>
                    )}
                  </div>
                  {sideCell(pair.away, idx)}
                </div>
              );
            })}
            {resultLine && (
              <div className={cx("px-3 py-2 border-t border-stone-100 bg-stone-50 text-xs font-medium text-center", resultTone)}>
                <Trophy size={11} className="inline mr-1 -mt-0.5 text-amber-400" />{resultLine}
              </div>
            )}
          </div>
        );
      })}
      {matchday.pairings.bye && (
        <div className={cx("border rounded-2xl bg-white px-3 py-4 flex items-center justify-center gap-2 text-sm", viewerId === matchday.pairings.bye ? "border-amber-400/50 text-amber-600 font-medium" : "border-stone-200 text-stone-500")}>
          <Sparkles size={14} className="text-amber-400" /> {nameOf(matchday.pairings.bye)} has a bye — automatic win
        </div>
      )}
    </div>
  );
}

function MatrixView({ league, data, viewerId, adminMode, now }) {
  const [statusFilter, setStatusFilter] = useState("all");
  // Which matchdays have their full prediction grid expanded — for matchdays
  // with head-to-head pairings, the cards are the default view and the grid
  // is opt-in; matchdays without pairings show the grid as before.
  const [openTables, setOpenTables] = useState({});

  const board = useMemo(() => computeLeaderboardWithPredictions(league.participants, publishedMatchdays(league), data.predictions, league.adjustments), [league, data.predictions]);
  const boardById = useMemo(() => Object.fromEntries(board.map((r) => [r.id, r])), [board]);
  const nameById = useMemo(() => Object.fromEntries(league.participants.map((p) => [p.id, p.name])), [league.participants]);

  // Rows: participants ordered by accumulated points so far (highest first),
  // matching the leaderboard's ranking.
  const participants = league.participants
    .slice()
    .sort((a, b) => (boardById[b.id]?.totalPoints ?? 0) - (boardById[a.id]?.totalPoints ?? 0));

  // Newest matchday first — the current round is what people open this tab
  // for, so it shouldn't be a season's worth of scrolling away.
  const matchdays = league.matchdays
    .filter((md) => adminMode || !md.draft)
    .filter((md) => statusFilter === "all" || matchdayDisplayStatus(md, adminMode, now) === statusFilter)
    .reverse();

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <h2 className="font-display font-semibold text-lg flex items-center gap-2"><BarChart3 size={18} className="text-amber-400" /> Predictions Matrix — {league.name}</h2>
        <div className="flex gap-2 flex-wrap">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="bg-white border border-stone-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50">
            <option value="all">All matchdays</option>
            <option value="open">Open</option>
            <option value="locked">Locked</option>
            <option value="completed">Completed</option>
            {adminMode && <option value="draft">Draft</option>}
            {adminMode && <option value="pending publish">Pending publish</option>}
          </select>
        </div>
      </div>

      {matchdays.map((md) => {
        const released = adminMode || isReleased(md, now);
        return (
          <div key={md.id} className="space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <h3 className="font-display font-semibold">{md.label}</h3>
                {md.scheduledDate && <span className="text-xs font-normal normal-case text-violet-700 flex items-center gap-1"><Calendar size={12} /> {fmtDateOnly(md.scheduledDate)}</span>}
                <span className={cx("text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide", MATCHDAY_STATUS_STYLES[matchdayDisplayStatus(md, adminMode, now)])}>
                  {matchdayDisplayStatus(md, adminMode, now)}
                </span>
              </div>
              <span className={cx("text-xs flex items-center gap-1", released ? "text-emerald-600" : "text-stone-500")}>
                {released ? <Eye size={13} /> : <EyeOff size={13} />}
                {released ? "revealed to everyone" : `hides other picks until ${fmtDateTime(md.releaseAt)}`}
              </span>
            </div>
            {md.pairings && (
              <H2HPairingsPanel matchday={md} league={league} predictions={data.predictions} viewerId={viewerId} adminMode={adminMode} now={now} />
            )}
            {/* Opening blog: from the reveal time until results are published.
                Closing blog: from publish onward. Admin sees both, always. */}
            {(adminMode || (released && !md.resultsPublished)) && md.blog && md.blog.trim() && (
              <article className="border border-amber-400/20 bg-amber-400/5 rounded-2xl p-5">
                <div className="text-[10px] font-semibold text-amber-500 uppercase tracking-[0.2em] mb-1">Matchday programme</div>
                <h4 className="font-display font-bold text-lg text-stone-900 leading-tight">
                  {md.label}{md.scheduledDate ? ` · ${fmtDateOnly(md.scheduledDate)}` : ""}
                </h4>
                <div className="text-[11px] text-stone-400 mb-3 pb-2 border-b border-amber-400/20">By Admin</div>
                <p className="text-sm text-stone-800 leading-relaxed whitespace-pre-line">{md.blog}</p>
              </article>
            )}
            {(adminMode || md.resultsPublished) && md.closingBlog && md.closingBlog.trim() && (
              <article className="border border-violet-700/20 bg-violet-700/5 rounded-2xl p-5">
                <div className="text-[10px] font-semibold text-violet-700 uppercase tracking-[0.2em] mb-1">The full-time review</div>
                <h4 className="font-display font-bold text-lg text-stone-900 leading-tight">
                  {md.label}{md.scheduledDate ? ` · ${fmtDateOnly(md.scheduledDate)}` : ""}
                </h4>
                <div className="text-[11px] text-stone-400 mb-3 pb-2 border-b border-violet-700/20">By Admin</div>
                <p className="text-sm text-stone-800 leading-relaxed whitespace-pre-line">{md.closingBlog}</p>
              </article>
            )}
            {md.pairings && (
              <button
                onClick={() => setOpenTables((t) => ({ ...t, [md.id]: !t[md.id] }))}
                className="text-xs text-stone-500 hover:text-stone-900 flex items-center gap-1"
              >
                <BarChart3 size={12} /> {openTables[md.id] ? "Hide full prediction grid" : "Show full prediction grid"}
              </button>
            )}
            {(!md.pairings || openTables[md.id]) && (
            <div className="overflow-x-auto border border-stone-200 rounded-2xl">
              <table className="min-w-full text-sm">
                <thead>
                  <tr style={{ background: "#3D1F5C" }}>
                    <th className="text-left px-4 py-3 font-semibold sticky left-0 z-10 min-w-[160px] text-amber-300" style={{ background: "#3D1F5C" }}>Contestant</th>
                    <th className="text-right px-3 py-3 font-semibold min-w-[70px] text-amber-300">Pts</th>
                    {md.matches.map((m, idx) => {
                      const isFreeCol = md.freeMatchIndex === idx;
                      const isBonanzaFreeCol = md.bonanza && idx < 2;
                      const isBonanzaAnchorCol = md.bonanza && idx === 2;
                      return (
                        <th key={m.id} className="text-center px-3 py-3 font-semibold min-w-[130px] text-amber-300">
                          {isBonanzaAnchorCol ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <div>{m.home}</div>
                              <div className="text-stone-300 font-normal normal-case text-[11px]">v {m.away}</div>
                              <span className="text-stone-300 font-normal normal-case text-[10px]" title="Away contestants predict this anchor match; home contestants pick their own">anchor — home contestants pick their own</span>
                              {m.outcome && (adminMode || md.resultsPublished) && <div className="text-amber-300 font-mono-num text-[11px] mt-0.5">{m.outcome.home}–{m.outcome.away}</div>}
                            </div>
                          ) : (isFreeCol || isBonanzaFreeCol) ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span>Match {idx + 1}</span>
                              <span className="text-stone-300 font-normal normal-case text-[10px]" title={isBonanzaFreeCol ? "Bonanza — every contestant picks their own match here" : "Each pairing's home contestant may have swapped this for their own match"}>varies by contestant</span>
                            </div>
                          ) : (
                            <>
                              <div>{m.home}</div>
                              <div className="text-stone-300 font-normal normal-case text-[11px]">v {m.away}</div>
                              {m.outcome && (adminMode || md.resultsPublished) && <div className="text-amber-300 font-mono-num text-[11px] mt-0.5">{m.outcome.home}–{m.outcome.away}</div>}
                            </>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {participants.map((p, idx) => (
                    <tr key={p.id} className={cx("border-t border-stone-200", idx % 2 === 0 ? "bg-white" : "bg-transparent")}>
                      <td className="px-4 py-3 sticky left-0 bg-inherit backdrop-blur z-10">
                        <div className="flex items-center gap-2 font-medium">
                          <span className="text-stone-500 font-mono-num text-xs">#{boardById[p.id]?.rank ?? "–"}</span>
                          {p.name}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono-num text-amber-300 font-semibold">{boardById[p.id]?.totalPoints ?? 0}</td>
                      {md.matches.map((defaultMatch, colIdx) => {
                        const isFreeCol = md.freeMatchIndex === colIdx;
                        // Columns where the fixture can vary per contestant:
                        // the normal free slot, or (on a Bonanza matchday)
                        // every slot.
                        const isPickCol = isFreeCol || md.bonanza;
                        // Each row's actual match at this slot — the default
                        // fixture, unless this row's contestant has swapped
                        // it for their own (free match or Bonanza pick).
                        const m = isPickCol ? effectiveMatchesFor(md, p.id)[colIdx] : defaultMatch;
                        // A contestant's OWN chosen fixture (never the admin
                        // default) — these get the stricter hiding below.
                        const isOwnPick = m.id.startsWith("custom__") || m.id.startsWith("bonanza__");
                        const pred = data.predictions[`${m.id}__${p.id}`];
                        const isSelf = p.id === viewerId;
                        // Own picks follow the same reveal as everyone's
                        // scorelines: hidden before the reveal time (so
                        // nobody can copy a pick), then fully visible —
                        // WHICH match was chosen and the scoreline — from
                        // the moment predictions are revealed.
                        const canSeeCustomPick = adminMode || released || isSelf;
                        const canSeeValue = released || isSelf;
                        const status = cellStatus(md, !!pred, now);
                        const Icon = STATUS_ICON[status];
                        return (
                          <td key={defaultMatch.id} className="px-3 py-3 text-center">
                            {isPickCol && (
                              !isOwnPick ? (
                                colIdx !== 2 || !md.bonanza ? (
                                  <div className="text-[10px] text-stone-500 leading-tight mb-1">
                                    {m.home} v {m.away}
                                    {m.outcome && (adminMode || md.resultsPublished) && <span className="text-amber-300"> ({m.outcome.home}–{m.outcome.away})</span>}
                                  </div>
                                ) : null /* the anchor column header already names the fixture */
                              ) : canSeeCustomPick ? (
                                <div className="text-[10px] text-stone-500 leading-tight mb-1">
                                  {m.home} v {m.away}
                                  {m.outcome && (adminMode || md.resultsPublished) && <span className="text-amber-300"> ({m.outcome.home}–{m.outcome.away})</span>}
                                </div>
                              ) : (
                                <div className="text-[10px] text-stone-400 italic leading-tight mb-1 flex items-center justify-center gap-1">
                                  <EyeOff size={9} /> pick hidden until predictions are revealed
                                </div>
                              )
                            )}
                            <span className={cx("inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-xs font-medium", STATUS_STYLES[status])}>
                              <Icon size={12} />
                              {status === "submitted" ? (canSeeValue ? `${pred.home}–${pred.away}` : "Submitted") : status[0].toUpperCase() + status.slice(1)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
            {released && <MatchStatsPanel matchday={md} predictions={data.predictions} />}
          </div>
        );
      })}
      {matchdays.length === 0 && <p className="text-stone-500 text-sm">No matchdays match this filter.</p>}
    </div>
  );
}

// Aggregate stats for one match: how contestants split across home/draw/away,
// and the average scoreline predicted (simple mean of submitted home/away
// goal counts). Only ever rendered once a matchday is revealed.
function computeMatchStats(match, predictions) {
  const preds = Object.entries(predictions)
    .filter(([key]) => key.startsWith(`${match.id}__`))
    .map(([, v]) => v);
  const total = preds.length;
  const counts = { home: 0, draw: 0, away: 0 };
  let sumHome = 0, sumAway = 0;
  preds.forEach((p) => {
    counts[resultOf(p.home, p.away)] += 1;
    sumHome += p.home;
    sumAway += p.away;
  });
  const pct = (n) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    total,
    home: { count: counts.home, pct: pct(counts.home) },
    draw: { count: counts.draw, pct: pct(counts.draw) },
    away: { count: counts.away, pct: pct(counts.away) },
    avgHome: total > 0 ? Math.round((sumHome / total) * 10) / 10 : null,
    avgAway: total > 0 ? Math.round((sumAway / total) * 10) / 10 : null,
  };
}

function MatchStatsPanel({ matchday, predictions }) {
  const statsMatches = matchday.bonanza
    ? matchday.matches.filter((_, idx) => idx === 2) // only the anchor is a shared fixture on a Bonanza matchday
    : matchday.matches.filter((_, idx) => idx !== matchday.freeMatchIndex);
  return (
    <div className="border border-stone-200 rounded-2xl p-4 bg-white">
      <h4 className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-3 flex items-center gap-1.5"><BarChart3 size={13} /> What the league predicted</h4>
      {matchday.bonanza ? (
        <p className="text-[11px] text-stone-500 mb-3">Bonanza matchday — everyone picked their own matches, so only the anchor match (predicted by away contestants) can be summarized.</p>
      ) : (matchday.freeMatchIndex !== null && matchday.freeMatchIndex !== undefined) && (
        <p className="text-[11px] text-stone-500 mb-3">The free match slot is skipped here — it's a different fixture for each home contestant, so it can't be summarized as one match.</p>
      )}
      <div className="grid sm:grid-cols-3 gap-4">
        {statsMatches.map((m) => {
          const stats = computeMatchStats(m, predictions);
          return (
            <div key={m.id} className="space-y-2">
              <div className="text-xs font-medium truncate">{m.home} v {m.away}</div>
              {stats.total === 0 ? (
                <p className="text-xs text-stone-500">No predictions yet.</p>
              ) : (
                <>
                  {[
                    ["Home win", stats.home, "bg-amber-400"],
                    ["Draw", stats.draw, "bg-zinc-400"],
                    ["Away win", stats.away, "bg-zinc-600"],
                  ].map(([label, s, barColor]) => (
                    <div key={label}>
                      <div className="flex justify-between text-[11px] text-stone-500 mb-0.5">
                        <span>{label}</span>
                        <span className="font-mono-num">{s.count} · {s.pct}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-stone-200 overflow-hidden">
                        <div className={cx("h-full rounded-full", barColor)} style={{ width: `${s.pct}%` }} />
                      </div>
                    </div>
                  ))}
                  <p className="text-[11px] text-stone-500 pt-1">
                    Average predicted scoreline: <span className="font-mono-num text-stone-700">{stats.avgHome}–{stats.avgAway}</span> ({stats.total} prediction{stats.total === 1 ? "" : "s"})
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// ADMIN VIEW
// -----------------------------------------------------------------------------
// Shows exactly how full each of the app's storage buckets actually is,
// computed live from the real current data — so admin can see a problem
// coming (and know exactly where) rather than finding out only when a save
// fails. The 5MB figure is a conservative safety guide carried over from
// the old platform — the database behind this site doesn't enforce a hard
// per-key cap, but keeping each bucket under it keeps saves fast and
// payload sizes sensible.
const STORAGE_KEY_LIMIT_BYTES = 5 * 1024 * 1024;

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function StorageUsageCard({ data }) {
  const split = splitData(data);
  const buckets = [
    ["Core settings", split.core],
    ["Accounts", split.accountsBlob],
    ["Roster", split.rosterBlob],
    ["Profile photos", split.photosBlob],
    ["Predictions", split.predictionsBlob],
    ["Season archives", split.archivesBlob],
    ["Badges", split.badgesBlob],
    ["History page", split.historyBlob],
  ].map(([label, blob]) => {
    const bytes = new Blob([JSON.stringify(blob)]).size;
    return { label, bytes, pct: Math.min(100, (bytes / STORAGE_KEY_LIMIT_BYTES) * 100) };
  });
  const fullest = buckets.reduce((max, b) => (b.pct > max.pct ? b : max), buckets[0]);

  return (
    <section className="bg-white border border-stone-200 rounded-2xl p-5 space-y-3">
      <h2 className="font-display font-semibold text-lg flex items-center gap-2"><BarChart3 size={18} className="text-amber-400" /> Storage usage</h2>
      <p className="text-xs text-stone-500">
        Each part of the app's data is saved separately. The {formatBytes(STORAGE_KEY_LIMIT_BYTES)} figure is a conservative guide rather than a hard database limit — this shows exactly how full each bucket really is, right now, so you can see a problem coming instead of finding out when a save slows down.
      </p>
      {fullest.pct >= 70 && (
        <div className="flex items-center gap-2 bg-amber-400/10 border border-amber-400/30 text-amber-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={16} className="shrink-0" />
          <span>{fullest.label} is at {fullest.pct.toFixed(0)}% of its guide limit — worth keeping an eye on, and reducing what's in it if you can (removing photos, or hiding/deleting old season honours, both help).</span>
        </div>
      )}
      <div className="space-y-2.5">
        {buckets.map((b) => (
          <div key={b.label}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-stone-600">{b.label}</span>
              <span className="font-mono-num text-stone-500">{formatBytes(b.bytes)} / {formatBytes(STORAGE_KEY_LIMIT_BYTES)}</span>
            </div>
            <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
              <div
                className={cx("h-full rounded-full", b.pct >= 90 ? "bg-rose-500" : b.pct >= 70 ? "bg-amber-400" : "bg-violet-600")}
                style={{ width: `${Math.max(2, b.pct)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function BackupsCard({ data, snapshots, onRestoreSnapshot, onDownload, onImportBackup, now }) {
  const [restoringId, setRestoringId] = useState(null);
  const [pendingRestoreId, setPendingRestoreId] = useState(null);
  const [justDownloaded, setJustDownloaded] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null); // { type: "ok" | "err", text }
  const importInputRef = useRef(null);

  const hoursSinceExport = data.lastManualExportAt ? (now - data.lastManualExportAt) / (60 * 60 * 1000) : Infinity;
  const needsReminder = hoursSinceExport > EXPORT_REMINDER_MS / (60 * 60 * 1000);

  const download = async () => {
    await onDownload();
    setJustDownloaded(true);
    setTimeout(() => setJustDownloaded(false), 2000);
  };

  const confirmRestore = (snapshot) => {
    setPendingRestoreId(snapshot.timestamp);
    setRestoringId(snapshot.timestamp);
    onRestoreSnapshot(snapshot.data).finally(() => {
      setRestoringId(null);
      setPendingRestoreId(null);
    });
  };

  const handleImportFilePicked = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setImportMsg(null);
  };

  const cancelImport = () => {
    setImportFile(null);
    setImportMsg(null);
    if (importInputRef.current) importInputRef.current.value = "";
  };

  const confirmImport = async () => {
    if (!importFile) return;
    setImportBusy(true);
    setImportMsg(null);
    try {
      const ok = await onImportBackup(importFile);
      if (ok) {
        setImportMsg({ type: "ok", text: "Backup restored — everything in the file is now live for everyone." });
        setImportFile(null);
      } else {
        setImportMsg({ type: "err", text: "The backup was read fine, but saving it didn't go through — check your connection and try again." });
      }
    } catch (err) {
      setImportMsg({ type: "err", text: err?.message || "That file couldn't be restored." });
    } finally {
      setImportBusy(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  return (
    <section className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4">
      <h2 className="font-display font-semibold text-lg flex items-center gap-2"><ShieldCheck size={18} className="text-amber-400" /> Backups & data safety</h2>

      {needsReminder && (
        <div className="flex items-center gap-2 bg-amber-400/10 border border-amber-400/30 text-amber-300 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={16} />
          {data.lastManualExportAt
            ? "It's been over 72 hours since your last manual backup — worth downloading a fresh one."
            : "You haven't downloaded a manual backup yet — worth grabbing one now."}
        </div>
      )}

      <div>
        <p className="text-xs text-stone-500 mb-2">
          Downloads the entire app's data (every division, every prediction, all accounts) as a JSON file to your device — the only copy that lives fully outside this app.
        </p>
        <button onClick={download} className="flex items-center gap-2 bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-4 py-2 text-sm">
          {justDownloaded ? <CheckCircle2 size={16} /> : null} Download full backup now
        </button>
        <p className="text-xs text-stone-500 mt-2">
          Last manual backup: {data.lastManualExportAt ? fmtDateTime(new Date(data.lastManualExportAt).toISOString()) : "never"}
        </p>
      </div>

      <div className="border-t border-stone-200 pt-4">
        <p className="text-xs text-stone-500 mb-2">
          Restore from a downloaded backup file — replaces <strong>everything</strong> currently in the app (all divisions, predictions, accounts, honours and history) with the file's contents. This is also how league data from the old version of this app gets imported: download a backup there, then restore it here.
        </p>
        <button onClick={() => importInputRef.current?.click()} disabled={importBusy} className="flex items-center gap-2 border border-violet-700/40 text-violet-700 hover:bg-violet-700/5 disabled:opacity-50 font-semibold rounded-lg px-4 py-2 text-sm">
          <Upload size={15} /> Restore from backup file
        </button>
        <input ref={importInputRef} type="file" accept="application/json,.json" onChange={handleImportFilePicked} className="hidden" />
        {importFile && (
          <div className="mt-2 flex items-center gap-2 bg-amber-400/5 border border-amber-400/20 rounded-lg px-3 py-2 flex-wrap">
            <span className="text-xs text-amber-700">
              Overwrite ALL current data with <span className="font-mono-num">{importFile.name}</span>? This can't be undone — if in doubt, download a fresh backup above first.
            </span>
            <button
              onClick={confirmImport}
              disabled={importBusy}
              className="ml-auto text-xs bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-black font-semibold rounded px-2 py-1 shrink-0"
            >
              {importBusy ? "Restoring…" : "Yes, restore this file"}
            </button>
            <button onClick={cancelImport} disabled={importBusy} className="text-xs text-stone-500 hover:text-stone-900 shrink-0">Cancel</button>
          </div>
        )}
        {importMsg && (
          <div className={cx(
            "mt-2 flex items-center gap-2 text-sm rounded-lg px-3 py-2 border",
            importMsg.type === "ok" ? "bg-emerald-50 border-emerald-300/30 text-emerald-700" : "bg-rose-50 border-rose-300/30 text-rose-700"
          )}>
            {importMsg.type === "ok" ? <CheckCircle2 size={16} className="shrink-0" /> : <AlertCircle size={16} className="shrink-0" />}
            {importMsg.text}
          </div>
        )}
      </div>

      <div>
        <p className="text-xs text-stone-500 mb-2">
          Automatic snapshots (taken at most once every 24h, whenever someone has the app open — up to the last {MAX_SNAPSHOTS} are kept). These live inside the same storage as everything else, so they protect against mistakes, not against the storage itself failing.
        </p>
        {snapshots.length === 0 ? (
          <p className="text-xs text-stone-500">No automatic snapshots yet — one will be taken the next time the app is open, 24h after it was first set up.</p>
        ) : (
          <div className="space-y-2">
            {[...snapshots].reverse().map((s) => {
              const isPending = pendingRestoreId === s.timestamp;
              const isRestoring = restoringId === s.timestamp;
              return (
                <div key={s.timestamp} className="border border-stone-200 rounded-xl px-3 py-2 bg-stone-50">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono-num text-stone-700">{fmtDateTime(new Date(s.timestamp).toISOString())}</span>
                    {!isPending && (
                      <button
                        onClick={() => setPendingRestoreId(s.timestamp)}
                        disabled={restoringId !== null}
                        className="ml-auto text-xs text-stone-500 hover:text-amber-300 disabled:opacity-50"
                      >
                        Restore this snapshot
                      </button>
                    )}
                  </div>
                  {isPending && (
                    <div className="mt-2 flex items-center gap-2 bg-amber-400/5 border border-amber-400/20 rounded-lg px-3 py-2">
                      <span className="text-xs text-amber-300">Overwrite ALL current data with this snapshot? This can't be undone.</span>
                      <button
                        onClick={() => confirmRestore(s)}
                        disabled={isRestoring}
                        className="ml-auto text-xs bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-black font-semibold rounded px-2 py-1"
                      >
                        {isRestoring ? "Restoring…" : "Yes, restore"}
                      </button>
                      <button onClick={() => setPendingRestoreId(null)} disabled={isRestoring} className="text-xs text-stone-500 hover:text-stone-900">Cancel</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function SeasonCard({ data, persist }) {
  const [label, setLabel] = useState(data.seasonLabel);
  const [labelSaved, setLabelSaved] = useState(false);
  const [ending, setEnding] = useState(false);
  const [newLabel, setNewLabel] = useState(suggestNextSeasonLabel(data.seasonLabel));
  const [busy, setBusy] = useState(false);
  const [expandedArchiveId, setExpandedArchiveId] = useState(null);

  const saveLabel = async () => {
    if (!label.trim()) return;
    await persist({ ...data, seasonLabel: label.trim() });
    setLabelSaved(true);
    setTimeout(() => setLabelSaved(false), 1500);
  };

  const confirmEndSeason = async () => {
    if (!newLabel.trim()) return;
    setBusy(true);
    try {
      const ok = await persist(endSeason(data, newLabel.trim()));
      if (ok) setEnding(false);
    } finally {
      setBusy(false);
    }
  };

  const archives = [...(data.seasonArchives || [])].reverse();

  return (
    <section className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4">
      <h2 className="font-display font-semibold text-lg flex items-center gap-2"><Archive size={18} className="text-amber-400" /> Season</h2>

      <div>
        <label className="text-xs text-stone-500">Current season label</label>
        <div className="flex gap-2 mt-1.5 max-w-xs">
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="flex-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          <button onClick={saveLabel} className="bg-stone-200 hover:bg-stone-300 border border-stone-300 rounded-lg px-3 py-2 text-sm font-medium">
            {labelSaved ? <CheckCircle2 size={16} /> : "Save"}
          </button>
        </div>
      </div>

      {!ending ? (
        <button
          onClick={() => { setNewLabel(suggestNextSeasonLabel(data.seasonLabel)); setEnding(true); }}
          className="flex items-center gap-2 border border-amber-400/40 text-amber-300 hover:bg-amber-400/10 rounded-lg px-4 py-2 text-sm font-medium"
        >
          <Archive size={15} /> End "{data.seasonLabel}" & start a new season
        </button>
      ) : (
        <div className="border border-amber-400/30 bg-amber-400/5 rounded-xl p-4 space-y-3">
          <p className="text-xs text-stone-700">
            Archives every active division's full history from <strong>{data.seasonLabel}</strong> permanently, then resets live matchdays and standings to zero for the new season. Roster, logins and profiles carry over unchanged. Worth grabbing a manual backup above first, just in case.
          </p>
          <p className="text-xs text-stone-500">
            Starting a new season is also a good moment to check the <strong>Divisions</strong> section below — turn on League One or League Two there if you need them for the season ahead, or adjust any division's contestant cap.
          </p>
          <div>
            <label className="text-xs text-stone-500">New season label</label>
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. 2027-28" className="w-full mt-1 max-w-xs bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          </div>
          <div className="flex gap-2">
            <button
              onClick={confirmEndSeason}
              disabled={busy || !newLabel.trim()}
              className="flex items-center gap-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-black font-semibold rounded-lg px-4 py-2 text-sm"
            >
              {busy ? "Archiving…" : "Confirm: archive & start new season"}
            </button>
            <button onClick={() => setEnding(false)} className="text-sm text-stone-500 hover:text-stone-900 px-3 py-2">Cancel</button>
          </div>
        </div>
      )}

      {archives.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2 flex items-center gap-1.5"><History size={13} /> Past seasons</h3>
          <div className="space-y-2">
            {archives.map((season) => {
              const expanded = expandedArchiveId === season.id;
              return (
                <div key={season.id} className="border border-stone-200 rounded-xl bg-stone-50 overflow-hidden">
                  <button
                    onClick={() => setExpandedArchiveId(expanded ? null : season.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
                  >
                    <span className="font-display font-semibold text-sm">{season.label}</span>
                    <span className="text-xs text-stone-500">ended {fmtDateTime(season.endedAt)}</span>
                    <span className="ml-auto text-xs text-stone-500">{expanded ? "Hide" : "View final standings"}</span>
                  </button>
                  {expanded && (
                    <div className="px-3 pb-3 grid sm:grid-cols-2 gap-3">
                      {Object.values(season.leagues).map((leagueArchive) => (
                        <div key={leagueArchive.name} className="border border-stone-200 rounded-lg overflow-hidden">
                          <div className="bg-white px-3 py-1.5 text-xs font-semibold">{leagueArchive.name}</div>
                          <table className="min-w-full text-xs">
                            <tbody>
                              {leagueArchive.finalStandings.slice(0, 10).map((row) => (
                                <tr key={row.id} className="border-t border-stone-200">
                                  <td className="px-3 py-1.5 font-mono-num text-stone-500 w-10">#{row.rank}</td>
                                  <td className="px-3 py-1.5">{row.name}</td>
                                  <td className="px-3 py-1.5 text-right font-mono-num text-amber-300">{row.totalPoints}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// Lets the admin choose which of the four possible divisions are in use,
// and set each one's name and participant cap. Premier League is always
// on. A division can't be turned off while it still has contestants on
// its roster, so nobody's registration silently disappears.
function DivisionsCard({ data, persist }) {
  const [rows, setRows] = useState(() =>
    LEAGUE_DEFS.map((def) => ({
      key: def.key,
      alwaysEnabled: def.alwaysEnabled,
      enabled: data.leagues[def.key].enabled,
      name: data.leagues[def.key].name,
      maxParticipants: data.leagues[def.key].maxParticipants,
      minParticipants: data.leagues[def.key].minParticipants ?? DEFAULT_MIN_PARTICIPANTS,
    }))
  );
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Read live from `data` on every render rather than caching it in `rows`
  // state — the roster can change (contestants added or removed) while
  // this card stays mounted, and a cached count would silently go stale.
  const currentCountByKey = Object.fromEntries(LEAGUE_DEFS.map((def) => [def.key, data.leagues[def.key].participants.length]));

  const updateRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const save = async () => {
    for (const r of rows) {
      const currentCount = currentCountByKey[r.key];
      if (!r.enabled && currentCount > 0) {
        setError(`Can't disable ${r.name} — it still has ${currentCount} contestant${currentCount === 1 ? "" : "s"} on its roster. Remove them first if you no longer need this division.`);
        return;
      }
      if (r.enabled && r.maxParticipants < currentCount) {
        setError(`${r.name}'s cap can't be set below its current roster size (${currentCount}).`);
        return;
      }
      if (r.minParticipants < 1) {
        setError(`${r.name}'s minimum needs to be at least 1.`);
        return;
      }
      if (r.minParticipants > r.maxParticipants) {
        setError(`${r.name}'s minimum can't be higher than its cap.`);
        return;
      }
      if (!r.name.trim()) {
        setError("Every enabled division needs a name.");
        return;
      }
    }
    setError("");
    const nextLeagues = { ...data.leagues };
    rows.forEach((r) => {
      nextLeagues[r.key] = { ...nextLeagues[r.key], enabled: r.alwaysEnabled ? true : r.enabled, name: r.name.trim(), maxParticipants: r.maxParticipants, minParticipants: r.minParticipants };
    });
    await persist({ ...data, leagues: nextLeagues });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <section className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4">
      <h2 className="font-display font-semibold text-lg flex items-center gap-2"><Trophy size={18} className="text-amber-400" /> Divisions</h2>
      <p className="text-xs text-stone-500">
        Choose which divisions this competition uses, and each one's contestant cap and minimum. Premier League is always active. Turning a division on or off takes effect immediately — it isn't tied to season start/end.
      </p>

      {error && (
        <div className="flex items-center gap-2 bg-rose-50 border border-rose-300/30 text-rose-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      <div className="space-y-2">
        {rows.map((r) => {
          const currentCount = currentCountByKey[r.key];
          return (
          <div key={r.key} className="flex flex-wrap items-center gap-3 border border-stone-200 rounded-xl px-3 py-2 bg-stone-50">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={r.enabled}
                disabled={r.alwaysEnabled}
                onChange={(e) => updateRow(r.key, { enabled: e.target.checked })}
                className="accent-violet-700"
              />
            </label>
            <input
              value={r.name}
              onChange={(e) => updateRow(r.key, { name: e.target.value })}
              disabled={!r.enabled}
              className="bg-transparent font-medium text-sm focus:outline-none border-b border-transparent focus:border-stone-400 disabled:opacity-40 min-w-[160px]"
            />
            <div className="flex items-center gap-1.5 text-xs text-stone-500">
              <span>Min:</span>
              <input
                type="number"
                min={1}
                value={r.minParticipants}
                onChange={(e) => updateRow(r.key, { minParticipants: parseInt(e.target.value, 10) || 0 })}
                disabled={!r.enabled}
                className="w-16 bg-white border border-stone-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-violet-600/50 disabled:opacity-40"
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs text-stone-500">
              <span>Cap:</span>
              <input
                type="number"
                min={currentCount}
                value={r.maxParticipants}
                onChange={(e) => updateRow(r.key, { maxParticipants: parseInt(e.target.value, 10) || 0 })}
                disabled={!r.enabled}
                className="w-16 bg-white border border-stone-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-violet-600/50 disabled:opacity-40"
              />
            </div>
            <span className="text-[11px] text-stone-500 ml-auto">{currentCount} on roster</span>
          </div>
          );
        })}
      </div>

      <button onClick={save} className="flex items-center gap-2 bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-4 py-2 text-sm">
        {saved ? <CheckCircle2 size={16} /> : null} Save divisions
      </button>
    </section>
  );
}

function RoomSettingsCard({ currentPin, onUpdatePin }) {
  const [pin, setPin] = useState(currentPin);
  const [saved, setSaved] = useState(false);

  const save = () => {
    if (!pin.trim()) return;
    onUpdatePin(pin.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <section className="bg-white border border-stone-200 rounded-2xl p-5">
      <h2 className="font-display font-semibold text-lg mb-3 flex items-center gap-2"><ShieldCheck size={18} className="text-amber-400" /> Room settings</h2>
      <label className="text-xs text-stone-500">Admin PIN</label>
      <div className="flex gap-2 mt-1.5 max-w-xs">
        <input value={pin} onChange={(e) => setPin(e.target.value)} className="flex-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        <button onClick={save} className="bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-3 py-2 text-sm">
          {saved ? <CheckCircle2 size={16} /> : "Save"}
        </button>
      </div>
      <p className="text-xs text-stone-500 mt-2">Whoever knows this PIN can enter admin mode — share it only with people who should manage fixtures and outcomes.</p>
    </section>
  );
}

// Manual standings corrections — for when a mistake slips through during
// the season. Deliberately built as a layer of adjustments applied ON TOP
// of the computed standings (see computeLeaderboardWithPredictions), never
// by editing the underlying results: the record stays intact, every
// correction carries a note saying why, and any of them can be removed
// again to undo it.
function AdjustmentsCard({ league, leagueKey, data, persist }) {
  const [participantId, setParticipantId] = useState("");
  const [pointsDelta, setPointsDelta] = useState("");
  const [diffDelta, setDiffDelta] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const nameById = Object.fromEntries(league.participants.map((p) => [p.id, p.name]));
  const adjustments = league.adjustments || [];

  const fmtDelta = (n, suffix) => `${n > 0 ? "+" : ""}${n} ${suffix}`;

  const add = async () => {
    if (!participantId) { setError("Choose a contestant."); return; }
    const lp = Number(pointsDelta) || 0;
    const sd = Number(diffDelta) || 0;
    if (lp === 0 && sd === 0) { setError("Enter a non-zero league points and/or score difference change."); return; }
    if (!note.trim()) { setError("Add a short note saying what this corrects — so it's always clear later why the table doesn't match the raw results."); return; }
    setError("");
    const entry = { id: `adj_${Date.now()}`, participantId, leaguePoints: lp, scoreDiff: sd, note: note.trim(), createdAt: new Date().toISOString() };
    const ok = await persist({ ...data, leagues: { ...data.leagues, [leagueKey]: { ...league, adjustments: [...adjustments, entry] } } });
    if (ok) { setParticipantId(""); setPointsDelta(""); setDiffDelta(""); setNote(""); }
  };

  const remove = async (id) => {
    await persist({ ...data, leagues: { ...data.leagues, [leagueKey]: { ...league, adjustments: adjustments.filter((a) => a.id !== id) } } });
  };

  return (
    <section className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4">
      <h2 className="font-display font-semibold text-lg flex items-center gap-2"><Target size={18} className="text-amber-400" /> Standings corrections — {league.name}</h2>
      <p className="text-xs text-stone-500">
        Applies a manual change to a contestant's league points and/or score difference, on top of the computed standings — for correcting mistakes without touching the underlying results. Each correction shows here with its note, and removing it undoes it. Corrections are cleared automatically when a season ends (they're archived inside that season's final standings).
      </p>

      {error && (
        <div className="flex items-center gap-2 bg-rose-50 border border-rose-300/30 text-rose-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {adjustments.length > 0 && (
        <div className="space-y-2">
          {adjustments.map((adj) => (
            <div key={adj.id} className="flex flex-wrap items-center gap-3 border border-stone-200 rounded-xl px-3 py-2 bg-stone-50">
              <span className="font-medium text-sm">{nameById[adj.participantId] ?? "(removed contestant)"}</span>
              {(adj.leaguePoints || 0) !== 0 && (
                <span className={cx("font-mono-num text-sm font-semibold", adj.leaguePoints > 0 ? "text-emerald-600" : "text-rose-600")}>{fmtDelta(adj.leaguePoints, "pts")}</span>
              )}
              {(adj.scoreDiff || 0) !== 0 && (
                <span className={cx("font-mono-num text-sm", adj.scoreDiff > 0 ? "text-emerald-600" : "text-rose-600")}>{fmtDelta(adj.scoreDiff, "diff")}</span>
              )}
              <span className="text-xs text-stone-500 flex-1 min-w-[140px]">{adj.note} <span className="text-stone-400">· {fmtDateTime(adj.createdAt)}</span></span>
              <button onClick={() => remove(adj.id)} className="text-stone-500 hover:text-rose-600 shrink-0" title="Remove this correction (undoes it)"><X size={15} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="text-[10px] text-stone-500">Contestant</label>
          <select value={participantId} onChange={(e) => setParticipantId(e.target.value)} className="block bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50">
            <option value="">— choose —</option>
            {league.participants.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-stone-500">League pts (+/−)</label>
          <input type="number" step="1" value={pointsDelta} onChange={(e) => setPointsDelta(e.target.value)} placeholder="e.g. -3" className="block w-24 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <div>
          <label className="text-[10px] text-stone-500">Score diff (+/−)</label>
          <input type="number" step="1" value={diffDelta} onChange={(e) => setDiffDelta(e.target.value)} placeholder="e.g. 2" className="block w-24 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="text-[10px] text-stone-500">Why? (required)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. MD4 result entered wrong — corrected" className="block w-full bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <button onClick={add} className="flex items-center gap-1.5 bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-4 py-2 text-sm">
          <Plus size={15} /> Apply correction
        </button>
      </div>
    </section>
  );
}

// One roster entry: name, registration status, invite code, badge upload,
// and admin actions. Badge upload reuses the same client-side resize used
// for profile photos, so a big source image never bloats storage.
function RosterRow({ participant, claimed, copied, copyFailed, onCopyCode, onRegenerateCode, pendingRemove, onRequestRemove, onConfirmRemove, onCancelRemove, onSetBadge, onSetStadium, onMoveLeague, moveOptions, resetCode, onGenerateResetCode, onCancelResetCode }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [stadiumDraft, setStadiumDraft] = useState(participant.stadium ?? "");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetCopied, setResetCopied] = useState(false);

  useEffect(() => { setStadiumDraft(participant.stadium ?? ""); }, [participant.id, participant.stadium]);
  useEffect(() => { if (resetCode) setConfirmingReset(false); }, [resetCode]);

  const copyResetCode = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(resetCode);
      setResetCopied(true);
      setTimeout(() => setResetCopied(false), 1500);
    } catch {
      /* the code is visible on screen to select manually */
    }
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await resizeImageFile(file, 200);
      await onSetBadge(dataUrl);
    } catch {
      /* best-effort — badge upload failing shouldn't break the roster */
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="border border-stone-200 rounded-xl px-3 py-2 bg-stone-50">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Upload a badge"
          className="w-9 h-9 rounded-full border border-stone-300 bg-white flex items-center justify-center overflow-hidden shrink-0 hover:border-amber-400/50"
        >
          {participant.badge ? (
            <img src={participant.badge} alt="" className="w-full h-full object-contain" />
          ) : (
            <Camera size={13} className="text-stone-500" />
          )}
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
        <span className="font-medium min-w-[100px]">{participant.name}</span>
        <span className={cx(
          "text-[10px] px-2 py-0.5 rounded-full border font-medium uppercase tracking-wide",
          claimed ? "bg-emerald-50 text-emerald-700 border-emerald-300/30" : "bg-zinc-400/10 text-stone-500 border-zinc-500/30"
        )}>
          {claimed ? "Registered" : "Not registered"}
        </span>
        <code className="font-mono-num text-sm text-amber-300 bg-amber-400/5 border border-amber-400/20 rounded px-2 py-0.5 tracking-widest">{participant.code}</code>
        <button onClick={onCopyCode} className={cx("text-xs hover:text-stone-900", copyFailed ? "text-rose-600" : "text-stone-500")}>
          {copied ? "Copied!" : copyFailed ? "Couldn't copy — select the code above" : "Copy code"}
        </button>
        <button onClick={onRegenerateCode} className="text-xs text-stone-500 hover:text-stone-900" title="Invalidate the old code and issue a new one">
          Regenerate
        </button>
        {claimed && !resetCode && !confirmingReset && (
          <button onClick={() => setConfirmingReset(true)} className="text-xs text-stone-500 hover:text-stone-900" title="Generate a one-time password reset code for this contestant">
            Reset password
          </button>
        )}
        {moveOptions && moveOptions.length > 0 && (
          moveOptions.length === 1 ? (
            <button onClick={() => onMoveLeague(moveOptions[0].key)} className="text-xs text-stone-500 hover:text-stone-900" title={`Move to ${moveOptions[0].name}`}>
              Move to {moveOptions[0].name}
            </button>
          ) : (
            <select
              defaultValue=""
              onChange={(e) => { if (e.target.value) { onMoveLeague(e.target.value); e.target.value = ""; } }}
              className="text-xs bg-transparent text-stone-500 hover:text-stone-900 border border-stone-300 rounded px-1.5 py-1"
            >
              <option value="">Move to…</option>
              {moveOptions.map((opt) => <option key={opt.key} value={opt.key}>{opt.name}</option>)}
            </select>
          )
        )}
        {!pendingRemove && (
          <button onClick={onRequestRemove} className="ml-auto text-stone-500 hover:text-rose-600"><X size={15} /></button>
        )}
        {uploading && <span className="text-[10px] text-stone-500">uploading…</span>}
      </div>
      <div className="flex items-center gap-1.5 mt-1.5 pl-[3rem]">
        <Landmark size={11} className="text-stone-500 shrink-0" />
        <input
          value={stadiumDraft}
          onChange={(e) => setStadiumDraft(e.target.value)}
          onBlur={() => { if (stadiumDraft !== (participant.stadium ?? "")) onSetStadium(stadiumDraft.trim()); }}
          placeholder="Home stadium (optional)"
          className="text-xs bg-transparent text-stone-500 focus:text-stone-900 placeholder:text-stone-400 focus:outline-none border-b border-transparent focus:border-stone-400 w-52"
        />
      </div>
      {confirmingReset && !resetCode && (
        <div className="mt-2 flex items-center gap-2 bg-amber-400/5 border border-amber-400/20 rounded-lg px-3 py-2 flex-wrap">
          <span className="text-xs text-amber-700">
            Generate a one-time password reset code for {participant.name}? Their current password keeps working until they use the code — so this is safe to cancel later if they remember it.
          </span>
          <button onClick={onGenerateResetCode} className="ml-auto text-xs bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded px-2 py-1 shrink-0">Yes, generate</button>
          <button onClick={() => setConfirmingReset(false)} className="text-xs text-stone-500 hover:text-stone-900 shrink-0">Cancel</button>
        </div>
      )}
      {resetCode && (
        <div className="mt-2 flex items-center gap-2 bg-violet-700/5 border border-violet-700/20 rounded-lg px-3 py-2 flex-wrap">
          <KeyRound size={12} className="text-violet-700 shrink-0" />
          <span className="text-xs text-stone-600">Reset code:</span>
          <code className="font-mono-num text-sm text-violet-700 bg-white border border-violet-700/20 rounded px-2 py-0.5 tracking-widest">{resetCode}</code>
          <button onClick={copyResetCode} className="text-xs text-stone-500 hover:text-stone-900">{resetCopied ? "Copied!" : "Copy"}</button>
          <span className="text-[11px] text-stone-500 flex-1 min-w-[160px]">Send this privately to {participant.name} — they use it via "Forgotten your password?" on the login screen. Works once, then disappears.</span>
          <button onClick={onCancelResetCode} className="text-xs text-stone-500 hover:text-rose-600 shrink-0">Cancel reset</button>
        </div>
      )}
      {pendingRemove && (
        <div className="mt-2 flex items-center gap-2 bg-rose-50 border border-rose-300/20 rounded-lg px-3 py-2">
          <span className="text-xs text-rose-700">
            {claimed
              ? `${participant.name} has already registered — removing them also deletes their account and every prediction they've made. This can't be undone.`
              : `Remove ${participant.name} from the roster? This can't be undone.`}
          </span>
          <button onClick={onConfirmRemove} className="ml-auto text-xs bg-rose-600 hover:bg-rose-500 text-stone-900 font-semibold rounded px-2 py-1 shrink-0">
            Yes, remove
          </button>
          <button onClick={onCancelRemove} className="text-xs text-stone-500 hover:text-stone-900 shrink-0">Cancel</button>
        </div>
      )}
    </div>
  );
}

// Paste a list of names (one per line) to add many contestants at once —
// much faster than the one-at-a-time form when setting up a roster from
// scratch. Badges and per-person details still get added individually
// afterwards, since there's no way to bulk-match uploaded files to names.
function BulkAddParticipants({ disabled, onAdd }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);

  const submit = async () => {
    const names = text.split("\n").map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) return;
    const added = await onAdd(names);
    setResult(`Added ${added} of ${names.length} name${names.length === 1 ? "" : "s"}.`);
    setText("");
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} disabled={disabled} className="text-xs text-stone-500 hover:text-stone-900 mt-2 disabled:opacity-50">
        + Bulk add multiple names at once
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2 max-w-sm">
      <label className="text-xs text-stone-500">One name per line</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={"Guthrie\nMarjolin\nJackson\n…"}
        className="w-full bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
      />
      {result && <p className="text-xs text-emerald-700">{result}</p>}
      <div className="flex gap-2">
        <button onClick={submit} className="bg-stone-200 hover:bg-stone-300 border border-stone-300 rounded-lg px-3 py-1.5 text-sm font-medium">Add all</button>
        <button onClick={() => { setOpen(false); setResult(null); }} className="text-sm text-stone-500 hover:text-stone-900 px-2">Close</button>
      </div>
    </div>
  );
}

function AdminView({ league, leagueKey, data, persist, snapshots, onRestoreSnapshot, now }) {
  const [showNewMatchday, setShowNewMatchday] = useState(false);
  const [newName, setNewName] = useState("");
  const [copiedId, setCopiedId] = useState(null);
  const [copyFailedId, setCopyFailedId] = useState(null);
  const [pendingRemoveId, setPendingRemoveId] = useState(null);
  const [moveError, setMoveError] = useState("");
  const atCap = league.participants.length >= league.maxParticipants;
  const claimedIds = useMemo(() => new Set(Object.values(data.accounts).map((a) => a.participantId)), [data.accounts]);
  // Account lookup by contestant, for the password-reset flow: admin
  // generates a one-time code here; the contestant uses it on the login
  // screen's "Forgotten your password?" form to set a new password. Their
  // old password keeps working until the code is used — so a reset that
  // turns out to be unnecessary (they remembered it after all) costs
  // nothing and can simply be cancelled.
  const accountByParticipantId = useMemo(() => {
    const map = {};
    Object.entries(data.accounts).forEach(([email, acc]) => { map[acc.participantId] = { ...acc, email }; });
    return map;
  }, [data.accounts]);

  const generateResetCode = async (participantId) => {
    const acc = accountByParticipantId[participantId];
    if (!acc) return;
    const code = randomInviteCode(8);
    await persist({ ...data, accounts: { ...data.accounts, [acc.email]: { ...data.accounts[acc.email], resetCode: code } } });
  };

  const cancelResetCode = async (participantId) => {
    const acc = accountByParticipantId[participantId];
    if (!acc) return;
    const { resetCode, ...rest } = data.accounts[acc.email];
    await persist({ ...data, accounts: { ...data.accounts, [acc.email]: rest } });
  };

  const updatePin = async (newPin) => {
    await persist({ ...data, adminPin: newPin });
  };

  const downloadBackup = async () => {
    const payload = JSON.stringify(data, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `plp-2026-27-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    await persist({ ...data, lastManualExportAt: Date.now() });
  };

  // Reads a backup JSON file (downloaded from this app — or from the old
  // artifact version of it) and replaces ALL live data with its contents.
  // Runs through the same migrateData() every load runs through, so older
  // backups pick up any fields added since they were downloaded.
  const importBackupFile = async (file) => {
    let text;
    try {
      text = await file.text();
    } catch {
      throw new Error("That file couldn't be read — try selecting it again.");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("That file isn't valid JSON — make sure you're selecting a backup downloaded from this app.");
    }
    if (!parsed || typeof parsed !== "object" || !parsed.leagues || !parsed.predictions) {
      throw new Error("That file doesn't look like a PLP backup — it's missing the leagues/predictions data a backup always contains.");
    }
    const migrated = migrateData(parsed);
    return await persist(migrated);
  };

  const updateLeague = async (patch) => {
    await persist({ ...data, leagues: { ...data.leagues, [leagueKey]: { ...league, ...patch } } });
  };

  const addParticipant = async () => {
    const trimmed = newName.trim();
    if (!trimmed || atCap) return;
    await updateLeague({ participants: [...league.participants, { id: `p_${Date.now()}`, name: trimmed, code: randomInviteCode() }] });
    setNewName("");
  };

  const confirmRemoveParticipant = async (id) => {
    const participant = league.participants.find((p) => p.id === id);
    if (!participant) return;
    const nextAccounts = Object.fromEntries(Object.entries(data.accounts).filter(([, acc]) => acc.participantId !== id));
    const nextPredictions = Object.fromEntries(Object.entries(data.predictions).filter(([key]) => !key.endsWith(`__${id}`)));
    await persist({
      ...data,
      accounts: nextAccounts,
      predictions: nextPredictions,
      leagues: { ...data.leagues, [leagueKey]: { ...league, participants: league.participants.filter((p) => p.id !== id), adjustments: (league.adjustments || []).filter((a) => a.participantId !== id) } },
    });
    setPendingRemoveId(null);
  };

  const regenerateCode = async (id) => {
    await updateLeague({ participants: league.participants.map((p) => (p.id === id ? { ...p, code: randomInviteCode() } : p)) });
  };

  const copyCode = async (p) => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(p.code);
      setCopyFailedId(null);
      setCopiedId(p.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setCopiedId(null);
      setCopyFailedId(p.id);
      setTimeout(() => setCopyFailedId(null), 2500);
    }
  };

  const setBadge = async (id, badge) => {
    await updateLeague({ participants: league.participants.map((p) => (p.id === id ? { ...p, badge } : p)) });
  };

  const setStadium = async (id, stadium) => {
    await updateLeague({ participants: league.participants.map((p) => (p.id === id ? { ...p, stadium } : p)) });
  };

  const otherLeagueKeys = enabledLeagueKeys(data).filter((k) => k !== leagueKey);
  const moveToLeague = async (id, targetKey) => {
    const participant = league.participants.find((p) => p.id === id);
    if (!participant) return;
    const targetLeague = data.leagues[targetKey];
    if (targetLeague.participants.length >= targetLeague.maxParticipants) {
      setMoveError(`${targetLeague.name} is already full (${targetLeague.maxParticipants}/${targetLeague.maxParticipants}).`);
      return;
    }
    setMoveError("");
    await persist({
      ...data,
      leagues: {
        ...data.leagues,
        [leagueKey]: { ...league, participants: league.participants.filter((p) => p.id !== id) },
        [targetKey]: { ...targetLeague, participants: [...targetLeague.participants, participant] },
      },
    });
  };

  const bulkAddParticipants = async (names) => {
    const room = league.maxParticipants - league.participants.length;
    const toAdd = names.slice(0, room).map((name, i) => ({
      id: `p_${Date.now()}_${i}`,
      name,
      code: randomInviteCode(),
    }));
    if (toAdd.length === 0) return 0;
    await updateLeague({ participants: [...league.participants, ...toAdd] });
    return toAdd.length;
  };

  const updateMatchday = async (mdId, patch) => {
    await updateLeague({ matchdays: league.matchdays.map((md) => (md.id === mdId ? { ...md, ...patch } : md)) });
  };

  const addMatchday = async (md) => {
    await updateLeague({ matchdays: [...league.matchdays, md] });
    setShowNewMatchday(false);
  };

  const addFixtureToPool = async (home, away, kickoff) => {
    await updateLeague({ fixturePool: [...league.fixturePool, { id: `f_${Date.now()}`, home, away, kickoff: kickoff || null }] });
  };

  const removeFixtureFromPool = async (id) => {
    await updateLeague({ fixturePool: league.fixturePool.filter((f) => f.id !== id) });
  };

  const generateH2HSchedule = async () => {
    const schedule = generateRoundRobinSchedule(league.participants.map((p) => p.id));
    await updateLeague({ h2hSchedule: schedule });
  };

  const setRoundDate = async (index, date) => {
    const nextSchedule = league.h2hSchedule.map((r, i) => (i === index ? { ...r, scheduledDate: date || null } : r));
    await updateLeague({ h2hSchedule: nextSchedule });
  };

  const bulkSetDates = async (startDateStr, intervalDays) => {
    if (!startDateStr) return;
    const start = new Date(`${startDateStr}T00:00:00`);
    const nextSchedule = league.h2hSchedule.map((r, i) => {
      const d = new Date(start.getTime() + i * intervalDays * 24 * 60 * 60 * 1000);
      return { ...r, scheduledDate: d.toISOString().slice(0, 10) };
    });
    await updateLeague({ h2hSchedule: nextSchedule });
  };

  const generateRandomMatchday = async () => {
    if (league.fixturePool.length < 3) return;
    const picked = [...league.fixturePool].sort(() => Math.random() - 0.5).slice(0, 3);
    const pickedIds = new Set(picked.map((f) => f.id));
    const roundIndex = league.matchdays.length;
    const newMatchday = {
      id: `md_${Date.now()}`,
      label: `Matchday ${roundIndex + 1}`,
      draft: true,
      resultsPublished: false,
      blog: "",
      releaseAt: null,
      locked: false,
      scoring: { resultPoints: 3, homeGoalPoints: 1, awayGoalPoints: 1, marginPoints: 1 },
      pairings: league.h2hSchedule[roundIndex] ?? null,
      scheduledDate: league.h2hSchedule[roundIndex]?.scheduledDate ?? null,
      freeMatchIndex: null,
      customMatches: {},
      bonanza: false,
      bonanzaPicks: {},
      matches: picked.map((f) => ({ id: f.id, home: f.home, away: f.away, kickoff: f.kickoff, outcome: null })),
    };
    await updateLeague({
      fixturePool: league.fixturePool.filter((f) => !pickedIds.has(f.id)),
      matchdays: [...league.matchdays, newMatchday],
    });
  };

  return (
    <div className="space-y-8">
      <StorageUsageCard data={data} />
      <BackupsCard data={data} snapshots={snapshots} onRestoreSnapshot={onRestoreSnapshot} onDownload={downloadBackup} onImportBackup={importBackupFile} now={now} />
      <SeasonCard data={data} persist={persist} />
      <DivisionsCard data={data} persist={persist} />
      <RoomSettingsCard currentPin={data.adminPin} onUpdatePin={updatePin} />
      <AdjustmentsCard league={league} leagueKey={leagueKey} data={data} persist={persist} />

      {/* Participants */}
      <section className="bg-white border border-stone-200 rounded-2xl p-5">
        <h2 className="font-display font-semibold text-lg mb-1 flex items-center gap-2"><Users size={18} className="text-amber-400" /> {league.name} roster ({league.participants.length}/{league.maxParticipants})</h2>
        <p className="text-xs text-stone-500 mb-4">Each contestant needs their own invite code to register — send it to them privately (not the whole list).</p>
        {moveError && (
          <div className="flex items-center gap-2 bg-rose-50 border border-rose-300/30 text-rose-700 text-sm rounded-lg px-3 py-2 mb-4">
            <AlertCircle size={16} /> {moveError}
          </div>
        )}
        <div className="space-y-2 mb-4">
          {league.participants.map((p) => (
            <RosterRow
              key={p.id}
              participant={p}
              claimed={claimedIds.has(p.id)}
              copied={copiedId === p.id}
              copyFailed={copyFailedId === p.id}
              onCopyCode={() => copyCode(p)}
              onRegenerateCode={() => regenerateCode(p.id)}
              pendingRemove={pendingRemoveId === p.id}
              onRequestRemove={() => setPendingRemoveId(p.id)}
              onConfirmRemove={() => confirmRemoveParticipant(p.id)}
              onCancelRemove={() => setPendingRemoveId(null)}
              onSetBadge={(badge) => setBadge(p.id, badge)}
              onSetStadium={(stadium) => setStadium(p.id, stadium)}
              resetCode={accountByParticipantId[p.id]?.resetCode ?? null}
              onGenerateResetCode={() => generateResetCode(p.id)}
              onCancelResetCode={() => cancelResetCode(p.id)}
              moveOptions={claimedIds.has(p.id) ? [] : otherLeagueKeys.map((k) => ({ key: k, name: data.leagues[k].name }))}
              onMoveLeague={(targetKey) => moveToLeague(p.id, targetKey)}
            />
          ))}
        </div>
        <div className="flex gap-2 max-w-sm">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addParticipant()}
            disabled={atCap}
            placeholder={atCap ? `Full — max ${league.maxParticipants}` : "Add a participant"}
            className="flex-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-violet-600/50 disabled:opacity-50"
          />
          <button onClick={addParticipant} disabled={atCap} className="flex items-center gap-1.5 bg-stone-200 hover:bg-stone-300 border border-stone-300 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50">
            <Plus size={16} /> Add
          </button>
        </div>
        <BulkAddParticipants disabled={atCap} onAdd={bulkAddParticipants} />
      </section>

      {/* Season-long head-to-head schedule */}
      <H2HScheduleCard league={league} onGenerate={generateH2HSchedule} onSetRoundDate={setRoundDate} onBulkSetDates={bulkSetDates} />

      {/* Fixture pool + random matchday generator */}
      <FixturePoolCard
        pool={league.fixturePool}
        onAdd={addFixtureToPool}
        onRemove={removeFixtureFromPool}
        onGenerate={generateRandomMatchday}
      />

      {/* Matchdays */}
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-display font-semibold text-lg flex items-center gap-2"><Settings2 size={18} className="text-amber-400" /> Matchdays</h2>
          <button onClick={() => setShowNewMatchday((s) => !s)} className="flex items-center gap-1.5 bg-stone-200 hover:bg-stone-300 border border-stone-300 rounded-lg px-3 py-1.5 text-sm font-medium">
            <Plus size={15} /> New matchday manually
          </button>
        </div>

        {showNewMatchday && <NewMatchdayForm league={league} onCreate={addMatchday} onCancel={() => setShowNewMatchday(false)} />}

        {league.matchdays.map((md) => (
          <MatchdayAdminCard
            key={md.id}
            matchday={md}
            participants={league.participants}
            predictions={data.predictions}
            onUpdate={(patch) => updateMatchday(md.id, patch)}
          />
        ))}
      </section>
    </div>
  );
}

// Generates (or regenerates) the season-long head-to-head schedule: every
// contestant plays every other contestant twice, home and away, in a
// pre-set rotation — exactly like a normal football season's fixture list.
// Each matchday, when created, pulls its pairings from the next unused
// round of this schedule (see generateRandomMatchday / NewMatchdayForm).
function H2HScheduleCard({ league, onGenerate, onSetRoundDate, onBulkSetDates }) {
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [bulkStart, setBulkStart] = useState("");
  const [bulkInterval, setBulkInterval] = useState(7);

  const n = league.participants.length;
  const minRequired = league.minParticipants ?? DEFAULT_MIN_PARTICIPANTS;
  const hasBye = n % 2 !== 0;
  const roundCount = n >= 2 ? 2 * (hasBye ? n : n - 1) : 0;
  const hasSchedule = league.h2hSchedule.length > 0;
  const nameById = Object.fromEntries(league.participants.map((p) => [p.id, p.name]));

  const generate = async () => {
    await onGenerate();
    setConfirmingRegenerate(false);
  };

  const applyBulkDates = () => {
    if (!bulkStart) return;
    onBulkSetDates(bulkStart, Number(bulkInterval) || 7);
  };

  return (
    <section className="bg-white border border-stone-200 rounded-2xl p-5 space-y-3">
      <h2 className="font-display font-semibold text-lg flex items-center gap-2"><Trophy size={18} className="text-amber-400" /> Season fixture list (head-to-head)</h2>
      <p className="text-xs text-stone-500">
        Generates the whole season's head-to-head pairings at once — every contestant plays every other contestant twice (home and away). Each matchday you create afterwards automatically picks up the next round's pairings and date.
      </p>

      {hasSchedule ? (
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-300/30 text-emerald-700 text-sm rounded-lg px-3 py-2">
          <CheckCircle2 size={16} /> {league.h2hSchedule.length}-round schedule generated for {n} contestants.
        </div>
      ) : (
        <p className="text-xs text-stone-500">No fixture list generated yet{n < minRequired ? ` — add at least ${minRequired} contestant${minRequired === 1 ? "" : "s"} first.` : "."}</p>
      )}

      {!hasSchedule && (
        <button
          onClick={generate}
          disabled={n < minRequired}
          className="flex items-center gap-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-black font-display font-semibold rounded-lg px-4 py-2.5 text-sm"
        >
          <Trophy size={15} /> Generate {roundCount}-round fixture list
        </button>
      )}

      {hasSchedule && !confirmingRegenerate && (
        <button onClick={() => setConfirmingRegenerate(true)} className="text-xs text-stone-500 hover:text-stone-900">
          Regenerate fixture list
        </button>
      )}
      {confirmingRegenerate && (
        <div className="flex items-center gap-2 bg-amber-400/5 border border-amber-400/20 rounded-lg px-3 py-2">
          <span className="text-xs text-amber-300">
            Regenerating replaces the {n}-contestant schedule going forward with a new {roundCount}-round one. Matchdays already created keep the pairings and dates they were given — only matchdays created after this will use the new schedule.
          </span>
          <button onClick={generate} className="ml-auto text-xs bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded px-2 py-1 shrink-0">Yes, regenerate</button>
          <button onClick={() => setConfirmingRegenerate(false)} className="text-xs text-stone-500 hover:text-stone-900 shrink-0">Cancel</button>
        </div>
      )}

      {hasSchedule && (
        <div className="border-t border-stone-200 pt-3">
          <label className="text-xs text-stone-400">Matchday dates for the season</label>
          <p className="text-[11px] text-stone-500 mb-2">Set every round's date at once, then fine-tune individual ones below — visible to contestants in the Fixture List from day one, even before you've created that round's matches yet.</p>
          <div className="flex flex-wrap items-end gap-2 mb-3">
            <div>
              <label className="text-[10px] text-stone-500">First matchday</label>
              <input type="date" value={bulkStart} onChange={(e) => setBulkStart(e.target.value)} className="block bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
            </div>
            <div>
              <label className="text-[10px] text-stone-500">Days between matchdays</label>
              <input type="number" min="1" value={bulkInterval} onChange={(e) => setBulkInterval(e.target.value)} className="block w-24 bg-stone-50 border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
            </div>
            <button onClick={applyBulkDates} disabled={!bulkStart} className="bg-stone-200 hover:bg-stone-300 disabled:opacity-50 rounded-lg px-3 py-2 text-sm font-medium">
              Fill all {league.h2hSchedule.length} dates
            </button>
          </div>

          <button onClick={() => setExpanded((e) => !e)} className="text-xs text-stone-500 hover:text-stone-900">
            {expanded ? "Hide" : "Show"} all {league.h2hSchedule.length} rounds & dates
          </button>
          {expanded && (
            <div className="mt-2 max-h-80 overflow-y-auto space-y-2 pr-1">
              {league.h2hSchedule.map((round, i) => (
                <div key={i} className="text-xs border border-stone-200 rounded-lg px-3 py-2 bg-stone-50 flex flex-wrap items-center gap-3">
                  <div className="min-w-[70px]">
                    <div className="text-stone-500 font-medium">Round {i + 1}</div>
                    <input
                      type="date"
                      value={round.scheduledDate ? round.scheduledDate.slice(0, 10) : ""}
                      onChange={(e) => onSetRoundDate(i, e.target.value)}
                      className="mt-1 bg-white border border-stone-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-violet-600/50"
                    />
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-stone-700">
                    {round.pairings.map((p, j) => (
                      <span key={j}>{nameById[p.home] ?? "?"} v {nameById[p.away] ?? "?"}</span>
                    ))}
                    {round.bye && <span className="text-stone-500">Bye: {nameById[round.bye] ?? "?"}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function FixturePoolCard({ pool, onAdd, onRemove, onGenerate }) {
  const [home, setHome] = useState("");
  const [away, setAway] = useState("");
  const [kickoff, setKickoff] = useState("");

  const add = () => {
    if (!home.trim() || !away.trim()) return;
    onAdd(home.trim(), away.trim(), kickoff ? new Date(kickoff).toISOString() : null);
    setHome(""); setAway(""); setKickoff("");
  };

  return (
    <section className="bg-white border border-stone-200 rounded-2xl p-5">
      <h2 className="font-display font-semibold text-lg mb-1 flex items-center gap-2"><Sparkles size={18} className="text-amber-400" /> Fixture pool</h2>
      <p className="text-xs text-stone-500 mb-4">Add the candidate matches for upcoming rounds here, then randomly draw 3 for the next matchday. Drawn fixtures are removed from the pool.</p>

      <div className="space-y-2 mb-4">
        {pool.length === 0 && <p className="text-xs text-stone-500">No fixtures in the pool yet — add some below.</p>}
        {pool.map((f) => (
          <div key={f.id} className="flex flex-wrap items-center gap-3 border border-stone-200 rounded-xl px-3 py-2 bg-stone-50">
            <span className="text-sm">{f.home} <span className="text-stone-500">v</span> {f.away}</span>
            {f.kickoff && <span className="text-xs text-stone-500 flex items-center gap-1"><Calendar size={12} /> {fmtDateTime(f.kickoff)}</span>}
            <button onClick={() => onRemove(f.id)} className="ml-auto text-stone-500 hover:text-rose-600"><X size={15} /></button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input value={home} onChange={(e) => setHome(e.target.value)} placeholder="Home team" className="flex-1 min-w-[140px] bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        <input value={away} onChange={(e) => setAway(e.target.value)} placeholder="Away team" className="flex-1 min-w-[140px] bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        <input type="datetime-local" value={kickoff} onChange={(e) => setKickoff(e.target.value)} className="bg-white border border-stone-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        <button onClick={add} className="flex items-center gap-1.5 bg-stone-200 hover:bg-stone-300 border border-stone-300 rounded-lg px-3 py-2 text-sm font-medium">
          <Plus size={15} /> Add to pool
        </button>
      </div>

      <button
        onClick={onGenerate}
        disabled={pool.length < 3}
        className="flex items-center gap-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-black font-display font-semibold rounded-lg px-4 py-2.5 text-sm"
      >
        <Sparkles size={15} /> Randomly draw next matchday (3 matches)
      </button>
      {pool.length < 3 && <p className="text-xs text-stone-500 mt-2">Add at least 3 fixtures to the pool to draw a matchday.</p>}
    </section>
  );
}

function MatchdayAdminCard({ matchday, participants, predictions, onUpdate }) {
  const [label, setLabel] = useState(matchday.label);
  const [scheduledDate, setScheduledDate] = useState(matchday.scheduledDate ? matchday.scheduledDate.slice(0, 10) : "");
  const [releaseAt, setReleaseAt] = useState(toLocalInputValue(matchday.releaseAt));
  const [predictionsCloseAt, setPredictionsCloseAt] = useState(toLocalInputValue(matchday.predictionsCloseAt));
  const [locked, setLocked] = useState(matchday.locked);
  const [scoring, setScoring] = useState(matchday.scoring);
  const [blog, setBlog] = useState(matchday.blog || "");
  const [closingBlog, setClosingBlog] = useState(matchday.closingBlog || "");
  const [matches, setMatches] = useState(matchday.matches.map((m) => ({ ...m, outcomeHome: m.outcome?.home ?? "", outcomeAway: m.outcome?.away ?? "" })));
  const [freeMatchIndex, setFreeMatchIndex] = useState(matchday.freeMatchIndex ?? null);
  const [customOutcomes, setCustomOutcomes] = useState(() => {
    const out = {};
    Object.entries(matchday.customMatches || {}).forEach(([homeId, c]) => {
      out[homeId] = { outcomeHome: c.outcome?.home ?? "", outcomeAway: c.outcome?.away ?? "" };
    });
    return out;
  });
  // Bonanza picks' outcomes, keyed "participantId__slot" — same pattern as
  // customOutcomes but per slot, since one contestant can have up to 3 picks.
  const [bonanzaOutcomes, setBonanzaOutcomes] = useState(() => {
    const out = {};
    Object.entries(matchday.bonanzaPicks || {}).forEach(([pid, slots]) => {
      Object.entries(slots).forEach(([slot, pick]) => {
        out[`${pid}__${slot}`] = { outcomeHome: pick.outcome?.home ?? "", outcomeAway: pick.outcome?.away ?? "" };
      });
    });
    return out;
  });
  const [saved, setSaved] = useState(false);

  const setMatchField = (idx, field, val) =>
    setMatches((arr) => arr.map((m, i) => (i === idx ? { ...m, [field]: val } : m)));

  const setCustomOutcomeField = (homeId, field, val) =>
    setCustomOutcomes((o) => ({ ...o, [homeId]: { ...o[homeId], [field]: val } }));

  const setBonanzaOutcomeField = (key, field, val) =>
    setBonanzaOutcomes((o) => ({ ...o, [key]: { ...o[key], [field]: val } }));

  // Admin's escape hatch for a mistyped Bonanza pick: clears the pick (the
  // contestant can then choose again). Any prediction made against the old
  // pick is simply orphaned — pick ids are unique per choice, so it can
  // never re-attach to the replacement.
  const clearBonanzaPick = (pid, slot) => {
    const next = JSON.parse(JSON.stringify(matchday.bonanzaPicks || {}));
    if (next[pid]) {
      delete next[pid][slot];
      if (Object.keys(next[pid]).length === 0) delete next[pid];
    }
    onUpdate({ bonanzaPicks: next });
  };

  const save = () => {
    const nextMatches = matches.map((m) => ({
      id: m.id,
      home: m.home,
      away: m.away,
      kickoff: m.kickoff,
      outcome: m.outcomeHome !== "" && m.outcomeAway !== "" ? { home: Number(m.outcomeHome), away: Number(m.outcomeAway) } : null,
    }));
    const nextCustomMatches = { ...(matchday.customMatches || {}) };
    Object.entries(customOutcomes).forEach(([homeId, o]) => {
      if (!nextCustomMatches[homeId]) return;
      nextCustomMatches[homeId] = {
        ...nextCustomMatches[homeId],
        outcome: o.outcomeHome !== "" && o.outcomeAway !== "" ? { home: Number(o.outcomeHome), away: Number(o.outcomeAway) } : null,
      };
    });
    const nextBonanzaPicks = JSON.parse(JSON.stringify(matchday.bonanzaPicks || {}));
    Object.entries(bonanzaOutcomes).forEach(([key, o]) => {
      const sep = key.lastIndexOf("__");
      const pid = key.slice(0, sep);
      const slot = key.slice(sep + 2);
      if (!nextBonanzaPicks[pid] || !nextBonanzaPicks[pid][slot]) return; // pick was cleared since — skip
      nextBonanzaPicks[pid][slot] = {
        ...nextBonanzaPicks[pid][slot],
        outcome: o.outcomeHome !== "" && o.outcomeAway !== "" ? { home: Number(o.outcomeHome), away: Number(o.outcomeAway) } : null,
      };
    });
    onUpdate({
      label,
      scheduledDate: scheduledDate || null,
      releaseAt: releaseAt ? new Date(releaseAt).toISOString() : null,
      predictionsCloseAt: predictionsCloseAt ? new Date(predictionsCloseAt).toISOString() : null,
      locked,
      scoring,
      blog,
      closingBlog,
      matches: nextMatches,
      freeMatchIndex: matchday.bonanza ? null : freeMatchIndex,
      customMatches: nextCustomMatches,
      bonanzaPicks: nextBonanzaPicks,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const allScored = matchday.matches.every((m) => m.outcome)
    && Object.values(matchday.customMatches || {}).every((c) => c.outcome)
    && Object.values(matchday.bonanzaPicks || {}).every((slots) => Object.values(slots).every((pick) => pick.outcome));
  const preview = useMemo(
    () => (allScored && !matchday.resultsPublished ? computeMatchdayPoints(matchday, predictions, participants) : null),
    [allScored, matchday, predictions, participants]
  );
  const h2hPreview = useMemo(
    () => (allScored && !matchday.resultsPublished ? computeH2HResultsForMatchday(matchday, predictions, participants) : null),
    [allScored, matchday, predictions, participants]
  );
  const nameById = useMemo(() => Object.fromEntries(participants.map((p) => [p.id, p.name])), [participants]);
  const stadiumById = useMemo(() => Object.fromEntries(participants.map((p) => [p.id, p.stadium])), [participants]);

  return (
    <div className="border border-stone-200 rounded-2xl p-5 bg-white space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="bg-transparent font-display font-semibold text-lg focus:outline-none border-b border-transparent focus:border-stone-400" />
          <label className="flex items-center gap-1.5 text-xs text-stone-500">
            <Calendar size={12} />
            <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} className="bg-stone-50 border border-stone-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          </label>
        </div>
        <span className={cx("text-[10px] px-2 py-1 rounded-full border font-medium uppercase tracking-wide", MATCHDAY_STATUS_STYLES[matchdayDisplayStatus(matchday, true)])}>
          {matchdayDisplayStatus(matchday, true)}
        </span>
      </div>

      {matchday.draft && (
        <div className="flex flex-wrap items-center gap-3 border border-amber-400/30 bg-amber-400/5 rounded-lg px-3 py-2.5">
          <span className="text-xs text-amber-300">This matchday is a draft — contestants can't see it exists yet. Review the fixtures below, then release it.</span>
          <button onClick={() => onUpdate({ draft: false })} className="ml-auto flex items-center gap-1.5 bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-3 py-1.5 text-xs shrink-0">
            <Eye size={13} /> Release to contestants
          </button>
        </div>
      )}

      <div className={cx("rounded-lg px-3 py-2.5 border", matchday.bonanza ? "border-amber-400/40 bg-amber-400/10" : "border-stone-200 bg-stone-50")}>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={!!matchday.bonanza}
            onChange={(e) => onUpdate(e.target.checked ? { bonanza: true, freeMatchIndex: null } : { bonanza: false })}
            className="accent-violet-700"
          />
          <Sparkles size={14} className="text-amber-500" /> Bonanza matchday
        </label>
        <p className="text-[11px] text-stone-500 mt-1">
          Every contestant picks their own matches: pairing homes pick all 3 (Premier League home contestants: any 3 PL matches; other divisions' homes: 2 PL matches + Match 3 from any division down to the National League). Away contestants and byes pick matches 1–2 (PL) and predict <strong>Match 3 below as the anchor</strong>. Your three fixtures stay as fallbacks — anyone who never picks a slot is scored on your fixture there, so enter results for all three. Supersedes the free-match slot.
        </p>
      </div>

      {matchday.pairings ? (
        <div className="border border-stone-200 rounded-lg px-3 py-2 bg-stone-50">
          <div className="text-[11px] text-stone-500 uppercase tracking-wide mb-1">Head-to-head pairings this matchday</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-700">
            {matchday.pairings.pairings.map((p, i) => (
              <span key={i}>
                {nameById[p.home] ?? "?"} v {nameById[p.away] ?? "?"}
                {stadiumById[p.home] && <span className="opacity-70"> · {stadiumById[p.home]}</span>}
              </span>
            ))}
            {matchday.pairings.bye && <span className="text-stone-500">Bye: {nameById[matchday.pairings.bye] ?? "?"}</span>}
          </div>
        </div>
      ) : (
        <p className="text-xs text-stone-500">No head-to-head pairings attached to this matchday — generate a season fixture list above before creating new matchdays so standings can be calculated.</p>
      )}

      <div className="grid sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-stone-500">Predictions close at (auto-locks — contestants see a live countdown)</label>
          <input type="datetime-local" value={predictionsCloseAt} onChange={(e) => setPredictionsCloseAt(e.target.value)} className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          <span className="text-[10px] text-stone-500">Blank = manual locking only. To reopen after a deadline passes, extend or clear it here.</span>
        </div>
        <div>
          <label className="text-xs text-stone-500">Reveal picks at</label>
          <input type="datetime-local" value={releaseAt} onChange={(e) => setReleaseAt(e.target.value)} className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} className="accent-violet-700" />
            Locked (manual override)
          </label>
        </div>
      </div>

      <div>
        <label className="text-xs text-stone-500">Opening blog (private until picks are revealed above; shows until results are published)</label>
        <textarea
          value={blog}
          onChange={(e) => setBlog(e.target.value)}
          rows={3}
          placeholder="Your preview for this matchday — only you can see this until the reveal time above, then it appears alongside the Predictions Matrix until the results go out."
          className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
        />
      </div>

      <div>
        <label className="text-xs text-stone-500">Closing blog (private until results are published — then it replaces the opening blog)</label>
        <textarea
          value={closingBlog}
          onChange={(e) => setClosingBlog(e.target.value)}
          rows={3}
          placeholder="Your review of how the matchday went — write it as you enter the results; it appears alongside the Predictions Matrix the moment you publish."
          className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
        />
      </div>

      <div>
        <label className="text-xs text-stone-500">Scoring — max {maxMatchPoints(scoring)} pts per match</label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1.5">
          <div>
            <label className="text-[10px] text-stone-500">Correct result</label>
            <input type="number" step="1" value={scoring.resultPoints} onChange={(e) => setScoring({ ...scoring, resultPoints: parseFloat(e.target.value) || 0 })} className="w-full bg-white border border-stone-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          </div>
          <div>
            <label className="text-[10px] text-stone-500">Home goals exact</label>
            <input type="number" step="1" value={scoring.homeGoalPoints} onChange={(e) => setScoring({ ...scoring, homeGoalPoints: parseFloat(e.target.value) || 0 })} className="w-full bg-white border border-stone-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          </div>
          <div>
            <label className="text-[10px] text-stone-500">Away goals exact</label>
            <input type="number" step="1" value={scoring.awayGoalPoints} onChange={(e) => setScoring({ ...scoring, awayGoalPoints: parseFloat(e.target.value) || 0 })} className="w-full bg-white border border-stone-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          </div>
          <div>
            <label className="text-[10px] text-stone-500">Margin exact</label>
            <input type="number" step="1" value={scoring.marginPoints} onChange={(e) => setScoring({ ...scoring, marginPoints: parseFloat(e.target.value) || 0 })} className="w-full bg-white border border-stone-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-stone-500">
          {matchday.bonanza
            ? "Fixtures — fallbacks for unpicked Bonanza slots; Match 3 is the anchor away contestants predict"
            : "Fixtures — optionally mark one as the \"free\" match each pairing's home contestant can swap out"}
        </label>
        {matches.map((m, idx) => (
          <div key={m.id} className="flex flex-wrap items-center gap-2 border border-stone-200 rounded-xl p-3 bg-white">
            {matchday.bonanza ? (
              idx === 2 && <span className="text-[10px] text-amber-600 font-semibold uppercase tracking-wide shrink-0" title="Away contestants predict this match">Anchor</span>
            ) : (
            <label className="flex items-center gap-1.5 text-[10px] text-stone-500" title="Home contestants can replace this match with their own">
              <input
                type="radio"
                name={`free-${matchday.id}`}
                checked={freeMatchIndex === idx}
                onChange={() => setFreeMatchIndex(idx)}
                className="accent-violet-700"
              />
              Free
            </label>
            )}
            <input value={m.home} onChange={(e) => setMatchField(idx, "home", e.target.value)} className="bg-transparent text-sm font-medium w-36 focus:outline-none border-b border-transparent focus:border-stone-400" />
            <span className="text-stone-500 text-xs">vs</span>
            <input value={m.away} onChange={(e) => setMatchField(idx, "away", e.target.value)} className="bg-transparent text-sm font-medium w-36 focus:outline-none border-b border-transparent focus:border-stone-400" />
            <input type="datetime-local" value={toLocalInputValue(m.kickoff)} onChange={(e) => setMatchField(idx, "kickoff", e.target.value ? new Date(e.target.value).toISOString() : "")} className="bg-white border border-stone-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
            <div className="flex items-center gap-1 ml-auto">
              <span className="text-[10px] text-stone-500 mr-1">Result</span>
              <input type="number" min="0" value={m.outcomeHome} onChange={(e) => setMatchField(idx, "outcomeHome", e.target.value)} className="w-12 text-center bg-white border border-stone-300 rounded-lg px-1 py-1 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
              <span className="text-stone-500">–</span>
              <input type="number" min="0" value={m.outcomeAway} onChange={(e) => setMatchField(idx, "outcomeAway", e.target.value)} className="w-12 text-center bg-white border border-stone-300 rounded-lg px-1 py-1 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
            </div>
          </div>
        ))}
        {!matchday.bonanza && freeMatchIndex !== null && (
          <button onClick={() => setFreeMatchIndex(null)} className="text-xs text-stone-500 hover:text-stone-900">Turn off free match for this matchday</button>
        )}
      </div>

      {matchday.bonanza && matchday.pairings && (
        <div>
          <label className="text-xs text-stone-500">Bonanza picks — every contestant's chosen matches; enter their real results here</label>
          <div className="space-y-2 mt-1.5">
            {participants.map((p) => {
              const slots = bonanzaSlotsFor(matchday, p.id);
              if (!slots) return null;
              const picks = matchday.bonanzaPicks?.[p.id] || {};
              return (
                <div key={p.id} className="border border-stone-200 rounded-xl p-3 bg-stone-50 space-y-2">
                  <div className="text-xs font-semibold">{p.name} <span className="text-stone-500 font-normal">— picks {slots.length} of 3{slots.length === 2 ? " (Match 3 is the anchor)" : ""}</span></div>
                  {slots.map((slot) => {
                    const pick = picks[slot];
                    if (!pick) {
                      return (
                        <div key={slot} className="text-xs text-stone-500 border border-stone-200 rounded-lg px-3 py-2 bg-white">
                          Match {slot + 1}: not picked yet — falls back to your fixture above if it stays that way.
                        </div>
                      );
                    }
                    const oKey = `${p.id}__${slot}`;
                    const o = bonanzaOutcomes[oKey] || { outcomeHome: "", outcomeAway: "" };
                    return (
                      <div key={slot} className="flex flex-wrap items-center gap-2 border border-stone-200 rounded-xl p-3 bg-white">
                        <span className="text-[10px] text-stone-500 shrink-0">Match {slot + 1}:</span>
                        <span className="text-sm font-medium">{pick.home} <span className="text-stone-500">v</span> {pick.away}</span>
                        <button onClick={() => clearBonanzaPick(p.id, slot)} className="text-[10px] text-stone-400 hover:text-rose-600" title="Clear this pick so the contestant can choose again (their prediction on it is discarded)">clear pick</button>
                        <div className="flex items-center gap-1 ml-auto">
                          <span className="text-[10px] text-stone-500 mr-1">Result</span>
                          <input type="number" min="0" value={o.outcomeHome} onChange={(e) => setBonanzaOutcomeField(oKey, "outcomeHome", e.target.value)} className="w-12 text-center bg-white border border-stone-300 rounded-lg px-1 py-1 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
                          <span className="text-stone-500">–</span>
                          <input type="number" min="0" value={o.outcomeAway} onChange={(e) => setBonanzaOutcomeField(oKey, "outcomeAway", e.target.value)} className="w-12 text-center bg-white border border-stone-300 rounded-lg px-1 py-1 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!matchday.bonanza && freeMatchIndex !== null && matchday.pairings && (
        <div>
          <label className="text-xs text-stone-500">Custom matches chosen by home contestants — enter their real results here too</label>
          <div className="space-y-2 mt-1.5">
            {matchday.pairings.pairings.map(({ home }) => {
              const custom = matchday.customMatches?.[home];
              const homeName = participants.find((p) => p.id === home)?.name ?? "?";
              if (!custom) {
                return (
                  <div key={home} className="text-xs text-stone-500 border border-stone-200 rounded-lg px-3 py-2 bg-stone-50">
                    {homeName} hasn't chosen their own match yet.
                  </div>
                );
              }
              const o = customOutcomes[home] || { outcomeHome: "", outcomeAway: "" };
              return (
                <div key={home} className="flex flex-wrap items-center gap-2 border border-stone-200 rounded-xl p-3 bg-white">
                  <span className="text-xs text-stone-500 min-w-[80px]">{homeName}'s pick:</span>
                  <span className="text-sm font-medium">{custom.home} <span className="text-stone-500">v</span> {custom.away}</span>
                  <div className="flex items-center gap-1 ml-auto">
                    <span className="text-[10px] text-stone-500 mr-1">Result</span>
                    <input type="number" min="0" value={o.outcomeHome} onChange={(e) => setCustomOutcomeField(home, "outcomeHome", e.target.value)} className="w-12 text-center bg-white border border-stone-300 rounded-lg px-1 py-1 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
                    <span className="text-stone-500">–</span>
                    <input type="number" min="0" value={o.outcomeAway} onChange={(e) => setCustomOutcomeField(home, "outcomeAway", e.target.value)} className="w-12 text-center bg-white border border-stone-300 rounded-lg px-1 py-1 text-sm font-mono-num focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button onClick={save} className="flex items-center gap-2 bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-4 py-2 text-sm">
        {saved ? <CheckCircle2 size={16} /> : null} Save changes
      </button>

      {matchday.resultsPublished ? (
        <p className="text-xs text-emerald-600 flex items-center gap-1.5"><CheckCircle2 size={14} /> Results published — standings are updated for everyone.</p>
      ) : preview ? (
        <div className="border-t border-stone-200 pt-4 space-y-3">
          <h4 className="text-xs font-semibold text-amber-300 uppercase tracking-wide">Results entered — check before publishing</h4>
          <div className="border border-stone-200 rounded-xl overflow-hidden">
            <table className="min-w-full text-sm">
              <thead>
                <tr style={{ background: "#3D1F5C" }} className="text-left">
                  <th className="px-3 py-2 font-semibold text-amber-300">Contestant</th>
                  <th className="px-3 py-2 font-semibold text-right text-amber-300">Points this matchday</th>
                  <th className="px-3 py-2 font-semibold text-amber-300">Head-to-head</th>
                  <th className="px-3 py-2 font-semibold text-right text-amber-300">League pts</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row, idx) => {
                  const h2h = h2hPreview?.[row.id];
                  return (
                    <tr key={row.id} className={cx("border-t border-stone-200", idx % 2 === 1 && "bg-white")}>
                      <td className="px-3 py-2">{row.name}</td>
                      <td className="px-3 py-2 text-right font-mono-num text-amber-300 font-semibold">{row.points}</td>
                      <td className="px-3 py-2 text-xs text-stone-500">
                        {!h2h ? "—"
                          : h2h.outcome === "bye" ? "Bye"
                          : `${h2h.outcome === "win" ? "Won" : h2h.outcome === "loss" ? "Lost" : "Drew"} v ${nameById[h2h.opponentId] ?? "?"} (${h2h.ownRaw}\u2013${h2h.opponentRaw})`}
                      </td>
                      <td className="px-3 py-2 text-right font-mono-num text-stone-700">{h2h ? h2h.leaguePoints : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-stone-500">This preview isn't visible to contestants yet. Publishing adds these results to the public standings and reveals the final scores in the Predictions Matrix.</p>
          <button
            onClick={() => onUpdate({ resultsPublished: true })}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-stone-900 font-semibold rounded-lg px-4 py-2 text-sm"
          >
            <CheckCircle2 size={16} /> Publish results & update standings
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NewMatchdayForm({ league, onCreate, onCancel }) {
  const [label, setLabel] = useState("");
  const [releaseAt, setReleaseAt] = useState("");
  const [fixtures, setFixtures] = useState([
    { home: "", away: "", kickoff: "" },
    { home: "", away: "", kickoff: "" },
    { home: "", away: "", kickoff: "" },
  ]);

  const setFixtureField = (idx, field, val) =>
    setFixtures((arr) => arr.map((f, i) => (i === idx ? { ...f, [field]: val } : f)));

  const create = () => {
    if (!label.trim() || fixtures.some((f) => !f.home.trim() || !f.away.trim())) return;
    const roundIndex = league.matchdays.length;
    onCreate({
      id: `md_${Date.now()}`,
      label: label.trim(),
      releaseAt: releaseAt ? new Date(releaseAt).toISOString() : null,
      draft: false,
      resultsPublished: false,
      blog: "",
      locked: false,
      scoring: { resultPoints: 3, homeGoalPoints: 1, awayGoalPoints: 1, marginPoints: 1 },
      pairings: league.h2hSchedule[roundIndex] ?? null,
      scheduledDate: league.h2hSchedule[roundIndex]?.scheduledDate ?? null,
      freeMatchIndex: null,
      customMatches: {},
      bonanza: false,
      bonanzaPicks: {},
      matches: fixtures.map((f, i) => ({
        id: `m_${Date.now()}_${i}`,
        home: f.home.trim(),
        away: f.away.trim(),
        kickoff: f.kickoff ? new Date(f.kickoff).toISOString() : null,
        outcome: null,
      })),
    });
  };

  return (
    <div className="border border-amber-400/30 bg-amber-400/5 rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-display font-semibold">New matchday — 3 fixtures</h3>
        <button onClick={onCancel} className="text-stone-500 hover:text-stone-800"><X size={18} /></button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-stone-500">Label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Matchday 3" className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <div>
          <label className="text-xs text-stone-500">Reveal picks at</label>
          <input type="datetime-local" value={releaseAt} onChange={(e) => setReleaseAt(e.target.value)} className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
      </div>
      <div className="space-y-2">
        {fixtures.map((f, idx) => (
          <div key={idx} className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-stone-500 w-14">Match {idx + 1}</span>
            <input value={f.home} onChange={(e) => setFixtureField(idx, "home", e.target.value)} placeholder="Home team" className="flex-1 min-w-[120px] bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
            <span className="text-stone-500 text-xs">vs</span>
            <input value={f.away} onChange={(e) => setFixtureField(idx, "away", e.target.value)} placeholder="Away team" className="flex-1 min-w-[120px] bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
            <input type="datetime-local" value={f.kickoff} onChange={(e) => setFixtureField(idx, "kickoff", e.target.value)} className="bg-white border border-stone-300 rounded-lg px-2 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
          </div>
        ))}
      </div>
      <button onClick={create} className="bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-4 py-2 text-sm">Create matchday</button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// LEADERBOARD
// -----------------------------------------------------------------------------
// Only matchdays the admin has explicitly published count toward what
// contestants see — this is what keeps row order in the Matrix/Standings
// from leaking a not-yet-confirmed result.
function publishedMatchdays(league) {
  return league.matchdays.filter((md) => md.resultsPublished);
}

// Predictions are keyed globally by matchId (not nested inside the league
// object), so the leaderboard calc takes the top-level predictions map too.
// `matchdays` is passed explicitly so callers decide whether unpublished
// results should count (e.g. the admin's own preview) or not (everyone else).
//
// Standings are head-to-head: each matchday's raw prediction points decide
// who wins that matchday's pairing (3 league points), draws (1 each), or
// loses (0) — see computeH2HResultsForMatchday. Table order is league
// points, then cumulative score difference, then alphabetical — exactly
// the tiebreak chain requested, so ties are (almost) always fully resolved.
//
// `adjustments` are the admin's manual corrections (see AdjustmentsCard) —
// applied as a layer ON TOP of the computed results, never by editing them,
// so the underlying record stays intact and any correction is visible and
// reversible.
function computeLeaderboardWithPredictions(participants, matchdays, predictions, adjustments = []) {
  const stats = {};
  participants.forEach((p) => {
    stats[p.id] = { id: p.id, name: p.name, leaguePoints: 0, scoreDifference: 0, wins: 0, draws: 0, losses: 0, predictedPointsTotal: 0, correctCount: 0, evaluatedCount: 0 };
  });

  matchdays.forEach((md) => {
    md.matches.forEach((m) => {
      if (!m.outcome) return;
      participants.forEach((p) => {
        const pred = predictions[`${m.id}__${p.id}`];
        const result = scoreMatch(m, pred, md.scoring);
        if (!result.evaluated) return;
        stats[p.id].evaluatedCount += 1;
        stats[p.id].predictedPointsTotal += result.points;
        if (result.correct) stats[p.id].correctCount += 1;
      });
    });

    const h2hResults = computeH2HResultsForMatchday(md, predictions, participants);
    Object.entries(h2hResults).forEach(([pid, h2h]) => {
      if (!stats[pid]) return; // participant may have since left the league
      stats[pid].leaguePoints += h2h.leaguePoints;
      stats[pid].scoreDifference += h2h.scoreDiff;
      if (h2h.outcome === "win" || h2h.outcome === "bye") stats[pid].wins += 1;
      else if (h2h.outcome === "draw") stats[pid].draws += 1;
      else if (h2h.outcome === "loss") stats[pid].losses += 1;
    });
  });

  // Manual corrections layer on top of everything computed above.
  (adjustments || []).forEach((adj) => {
    const s = stats[adj.participantId];
    if (!s) return; // adjustment for someone no longer in the league
    s.leaguePoints += adj.leaguePoints || 0;
    s.scoreDifference += adj.scoreDiff || 0;
  });

  const rows = participants.map((p) => {
    const s = stats[p.id];
    const accuracy = s.evaluatedCount > 0 ? Math.round((s.correctCount / s.evaluatedCount) * 1000) / 10 : 0;
    return {
      ...s,
      totalPoints: s.leaguePoints, // alias — anywhere already displaying "points" shows table points
      predictedPointsTotal: Math.round(s.predictedPointsTotal * 10) / 10,
      accuracy,
    };
  });

  rows.sort((a, b) => b.leaguePoints - a.leaguePoints || b.scoreDifference - a.scoreDifference || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// -----------------------------------------------------------------------------
// SEASON ARCHIVE — closing out a season snapshots everything about it
// (fixtures, every prediction, final standings) into a permanent record,
// then resets both leagues to a clean slate — same roster, same accounts,
// same invite codes, no live matchdays or standings — ready for the next
// season without anyone needing to re-register.
// -----------------------------------------------------------------------------
// All match ids belonging to a matchday — the 3 base fixtures plus any
// per-pairing custom matches home contestants have chosen. Used wherever
// predictions need to be matched back to "everything in this matchday."
function allMatchIdsForMatchday(md) {
  const ids = md.matches.map((m) => m.id);
  Object.keys(md.customMatches || {}).forEach((homeId) => ids.push(`custom__${md.id}__${homeId}`));
  Object.values(md.bonanzaPicks || {}).forEach((slots) => Object.values(slots).forEach((pick) => ids.push(pick.id)));
  return ids;
}

// Prediction keys are "<matchId>__<participantId>". Custom-match ids
// themselves contain "__" (custom__<matchdayId>__<homeId>), so splitting on
// the *first* "__" would cut a custom matchId in half. Participant ids
// never contain "__", so splitting on the *last* one is always correct.
function matchIdFromPredictionKey(key) {
  return key.slice(0, key.lastIndexOf("__"));
}

function endSeason(data, newSeasonLabel) {
  const archivedMatchIds = new Set();
  Object.values(data.leagues).forEach((league) => {
    league.matchdays.forEach((md) => allMatchIdsForMatchday(md).forEach((id) => archivedMatchIds.add(id)));
  });

  const archivedLeagues = {};
  Object.entries(data.leagues).forEach(([key, league]) => {
    if (!league.enabled) return;
    const matchIds = new Set();
    league.matchdays.forEach((md) => allMatchIdsForMatchday(md).forEach((id) => matchIds.add(id)));
    const leaguePredictions = {};
    Object.entries(data.predictions).forEach(([predKey, predVal]) => {
      if (matchIds.has(matchIdFromPredictionKey(predKey))) leaguePredictions[predKey] = predVal;
    });
    archivedLeagues[key] = {
      name: league.name,
      participants: league.participants.map((p) => ({ id: p.id, name: p.name, supports: p.supports || null, badge: p.badge || null })),
      matchdays: JSON.parse(JSON.stringify(league.matchdays)),
      predictions: leaguePredictions,
      finalStandings: computeLeaderboardWithPredictions(league.participants, publishedMatchdays(league), data.predictions, league.adjustments),
    };
  });

  const nextLeagues = {};
  Object.entries(data.leagues).forEach(([key, league]) => {
    nextLeagues[key] = { ...league, matchdays: [], fixturePool: [], adjustments: [] };
  });

  const remainingPredictions = {};
  Object.entries(data.predictions).forEach(([predKey, predVal]) => {
    if (!archivedMatchIds.has(matchIdFromPredictionKey(predKey))) remainingPredictions[predKey] = predVal;
  });

  const archiveRecord = {
    id: `season_${Date.now()}`,
    label: data.seasonLabel || "Previous season",
    endedAt: new Date().toISOString(),
    leagues: archivedLeagues,
  };

  return {
    ...data,
    seasonLabel: newSeasonLabel,
    seasonArchives: [...(data.seasonArchives || []), archiveRecord],
    leagues: nextLeagues,
    predictions: remainingPredictions,
  };
}

// "2026-27" -> "2027-28" — just a starting suggestion for the new season's
// label, the admin can always type over it.
function suggestNextSeasonLabel(label) {
  const m = /^(\d{4})-(\d{2,4})$/.exec(label || "");
  if (!m) return "";
  const nextStart = parseInt(m[1], 10) + 1;
  const nextEndShort = String((nextStart + 1) % 100).padStart(2, "0");
  return `${nextStart}-${nextEndShort}`;
}

// Renders the current standings as a shareable image (banner-purple card
// with logo, zone colours and points) and hands it to the device's native
// share sheet — on a phone that's two taps into the WhatsApp group. Where
// no share sheet exists (laptops), the image downloads instead. The site
// can't post into WhatsApp directly (WhatsApp doesn't allow that); the
// person always chooses the destination.
async function buildStandingsImage(league, leagueKey, seasonLabel, board, rowZoneClass) {
  const width = 760;
  const headerH = 128;
  const rowH = 42;
  const footerH = 44;
  const height = headerH + board.length * rowH + footerH;
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);

  ctx.fillStyle = "#3D1F5C";
  ctx.fillRect(0, 0, width, height);

  // Logo (best-effort — the card still works without it)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = "/plp-logo.png";
    });
    const lh = 96;
    ctx.drawImage(img, 24, 16, img.width * (lh / img.height), lh);
  } catch { /* no logo, no problem */ }

  const accent = leagueAccent(leagueKey);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = accent;
  ctx.font = "700 24px Oswald, ui-sans-serif, sans-serif";
  ctx.fillText(league.name.toUpperCase(), 110, 62);
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "500 13px Inter, ui-sans-serif, sans-serif";
  ctx.fillText(`Season ${seasonLabel} · Standings`, 110, 84);

  const ZONE_FILLS = {
    "bg-amber-400/5": "rgba(251,191,36,0.14)",
    "bg-yellow-200/20": "rgba(253,224,71,0.14)",
    "bg-sky-400/10": "rgba(56,189,248,0.16)",
    "bg-rose-400/10": "rgba(251,113,133,0.16)",
  };

  board.forEach((row, i) => {
    const y = headerH + i * rowH;
    const zone = rowZoneClass(row);
    ctx.fillStyle = zone && ZONE_FILLS[zone] ? ZONE_FILLS[zone] : i % 2 === 0 ? "rgba(255,255,255,0.04)" : "transparent";
    ctx.fillRect(16, y, width - 32, rowH);

    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "600 14px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillText(`#${row.rank}`, 30, y + 27);

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "600 16px Inter, ui-sans-serif, sans-serif";
    ctx.fillText(row.name, 78, y + 27);

    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "500 14px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillText(`${row.wins}-${row.draws}-${row.losses}`, width - 190, y + 27);
    ctx.fillText(`${row.scoreDifference > 0 ? "+" : ""}${row.scoreDifference}`, width - 110, y + 27);
    ctx.fillStyle = accent;
    ctx.font = "700 20px Oswald, ui-sans-serif, sans-serif";
    ctx.fillText(String(row.leaguePoints), width - 34, y + 29);
    ctx.textAlign = "left";
  });

  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "500 11px Inter, ui-sans-serif, sans-serif";
  ctx.fillText("Same game, same friends, new world", 24, height - 18);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function LeaderboardView({ league, leagueKey, data }) {
  const [shareState, setShareState] = useState(null); // null | "busy" | "downloaded" | "failed"

  const board = useMemo(() => computeLeaderboardWithPredictions(league.participants, publishedMatchdays(league), data.predictions, league.adjustments), [league, data.predictions]);
  // Premier League celebrates the top 4; every other division the top 2.
  const podium = board.filter((r) => r.leaguePoints > 0).slice(0, leagueKey === "league1" ? 4 : 2);
  const visibleMatchdays = league.matchdays.filter((md) => !md.draft);
  const totalMatches = visibleMatchdays.reduce((n, md) => n + md.matches.length, 0);
  const scoredMatches = publishedMatchdays(league).reduce((n, md) => n + md.matches.length, 0);

  // Finishing-position zones, colouring the table like a real league:
  //   Premier League — 1st keeps its gold highlight, 2nd–4th light blue,
  //   bottom three light red. Other divisions — 1st gold, 2nd a subtly
  //   different pale gold, 3rd–8th light blue, bottom three light red.
  //   The red (bottom-three) zone wins wherever a small roster would make
  //   zones overlap. Below 7 contestants, zones switch off entirely and
  //   only the leader's existing highlight remains — and nothing is
  //   coloured until at least one matchday's points are on the board.
  const zonesActive = league.participants.length >= 7 && board.some((r) => r.leaguePoints > 0);
  const rowZoneClass = (row) => {
    if (row.rank === 1 && row.leaguePoints > 0) return "bg-amber-400/5"; // the existing leader highlight
    if (!zonesActive) return null;
    const n = league.participants.length;
    if (row.rank > n - 3) return "bg-rose-400/10"; // bottom three
    if (leagueKey === "league1") {
      if (row.rank >= 2 && row.rank <= 4) return "bg-sky-400/10";
    } else {
      if (row.rank === 2) return "bg-yellow-200/20";
      if (row.rank >= 3 && row.rank <= 8) return "bg-sky-400/10";
    }
    return null;
  };

  const shareStandings = async () => {
    setShareState("busy");
    try {
      const blob = await buildStandingsImage(league, leagueKey, data.seasonLabel, board, rowZoneClass);
      if (!blob) throw new Error("no image");
      const file = new File([blob], `plp-standings-${new Date().toISOString().slice(0, 10)}.png`, { type: "image/png" });
      // Native share sheet where available (phones) — the person picks
      // WhatsApp and the group there.
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `${league.name} standings` });
          setShareState(null);
          return;
        } catch (err) {
          if (err && err.name === "AbortError") { setShareState(null); return; } // person closed the sheet — not an error
          /* fall through to download */
        }
      }
      // Laptops (no share sheet): download the image to attach manually.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setShareState("downloaded");
      setTimeout(() => setShareState(null), 3000);
    } catch {
      setShareState("failed");
      setTimeout(() => setShareState(null), 3000);
    }
  };

  // Form guide: each contestant's head-to-head outcome over the last four
  // published matchdays (oldest first), with a tooltip naming the opponent
  // and the raw score. Byes appear as "B" — automatic wins by rule, but
  // honestly labelled rather than dressed up as beaten opponents.
  const formById = useMemo(() => {
    const last = publishedMatchdays(league).slice(-4);
    const nameById = Object.fromEntries(league.participants.map((p) => [p.id, p.name]));
    const map = {};
    league.participants.forEach((p) => { map[p.id] = []; });
    last.forEach((md) => {
      const res = computeH2HResultsForMatchday(md, data.predictions, league.participants);
      league.participants.forEach((p) => {
        const r = res[p.id];
        if (!r) return;
        map[p.id].push({
          outcome: r.outcome,
          title: `${md.label}: ${r.outcome === "bye" ? "bye — automatic win" : `${r.outcome === "win" ? "beat" : r.outcome === "loss" ? "lost to" : "drew with"} ${nameById[r.opponentId] ?? "?"} ${r.ownRaw}–${r.opponentRaw}`}`,
        });
      });
    });
    return map;
  }, [league, data.predictions]);

  // Each contestant's rank BEFORE the most recent published matchday, for
  // the movement arrows — recomputed with the real standings calculation
  // (including manual corrections) so the comparison always matches the
  // live table's own tiebreak logic. Needs at least two published
  // matchdays to have a "previous table" to compare against; until then
  // everyone shows a dash.
  const prevRankById = useMemo(() => {
    const pubs = publishedMatchdays(league);
    if (pubs.length < 2) return null;
    const prevBoard = computeLeaderboardWithPredictions(league.participants, pubs.slice(0, -1), data.predictions, league.adjustments);
    return Object.fromEntries(prevBoard.map((r) => [r.id, r.rank]));
  }, [league, data.predictions]);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-display font-semibold text-lg flex items-center gap-2"><Trophy size={18} className="text-amber-400" /> {league.name} Standings</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={shareStandings}
            disabled={shareState === "busy"}
            className="flex items-center gap-1.5 text-xs bg-stone-200 hover:bg-stone-300 disabled:opacity-50 border border-stone-300 rounded-lg px-3 py-1.5 font-medium"
            title="Share the table as an image — on a phone this opens the share sheet (e.g. straight into WhatsApp); on a laptop it downloads the image"
          >
            <Share2 size={13} />
            {shareState === "busy" ? "Preparing…" : shareState === "downloaded" ? "Image downloaded" : shareState === "failed" ? "Couldn't create image" : "Share standings"}
          </button>
          <span className="text-xs text-stone-500">{scoredMatches} of {totalMatches} matches scored</span>
        </div>
      </div>
      <p className="text-xs text-stone-500 -mt-6">
        Head-to-head format: each matchday you're paired against another contestant — whoever scores more prediction points wins the matchup (3 pts), a tie draws (1 pt each). Ties in the table are broken by score difference, then alphabetically.
      </p>

      {podium.length === 0 ? (
        <p className="text-stone-500 text-sm">No results have been entered yet — the board will populate once matches are scored.</p>
      ) : (
        <Podium podium={podium} participants={league.participants} />
      )}

      <div className="border border-stone-200 rounded-2xl overflow-hidden">
        <table className="min-w-full text-sm">
          <thead>
            <tr style={{ background: "#3D1F5C" }} className="text-left">
              <th className="px-4 py-3 font-semibold w-16 text-amber-300">Rank</th>
              <th className="px-4 py-3 font-semibold text-amber-300">Participant</th>
              <th className="px-2 py-3 font-semibold text-center w-10 text-amber-300" title="Movement since the most recent matchday">±</th>
              <th className="hidden sm:table-cell px-2 py-3 font-semibold text-center text-amber-300" title="Last four matchdays, oldest first">Form</th>
              <th className="hidden sm:table-cell px-4 py-3 font-semibold text-right text-amber-300">W</th>
              <th className="hidden sm:table-cell px-4 py-3 font-semibold text-right text-amber-300">D</th>
              <th className="hidden sm:table-cell px-4 py-3 font-semibold text-right text-amber-300">L</th>
              <th className="px-3 sm:px-4 py-3 font-semibold text-right text-amber-300">Score diff</th>
              <th className="px-4 py-3 font-display font-bold text-right text-amber-300 bg-white/10">Pts</th>
            </tr>
          </thead>
          <tbody>
            {board.map((row, idx) => {
              const zone = rowZoneClass(row);
              return (
              <tr key={row.id} className={cx("border-t border-stone-200", zone ?? (idx % 2 === 1 && "bg-white"))}>
                <td className="px-4 py-3 font-mono-num text-stone-500">
                  <span className="inline-flex items-center gap-1">{row.rank === 1 && row.leaguePoints > 0 && <Crown size={14} className="text-amber-400" />}#{row.rank}</span>
                </td>
                <td className="px-4 py-3 font-medium">
                  <div className="flex items-center gap-2 min-w-0">
                    <BadgeAvatar participant={league.participants.find((p) => p.id === row.id)} name={row.name} size={26} />
                    <span className="truncate">{row.name}</span>
                  </div>
                </td>
                <td className="px-2 py-3 text-center">
                  {(() => {
                    const prevRank = prevRankById?.[row.id];
                    const movement = prevRank ? prevRank - row.rank : 0;
                    if (prevRankById && movement > 0) {
                      return <span className="text-emerald-600 text-[10px]" title={`Up ${movement} place${movement === 1 ? "" : "s"} (was #${prevRank})`}>▲</span>;
                    }
                    if (prevRankById && movement < 0) {
                      return <span className="text-rose-600 text-[10px]" title={`Down ${-movement} place${movement === -1 ? "" : "s"} (was #${prevRank})`}>▼</span>;
                    }
                    return <span className="text-stone-400" title="No change since the most recent matchday">–</span>;
                  })()}
                </td>
                <td className="hidden sm:table-cell px-2 py-3">
                  <div className="flex gap-0.5 justify-center">
                    {(formById[row.id] ?? []).map((f, fi) => (
                      <span
                        key={fi}
                        title={f.title}
                        className={cx(
                          "w-4 h-4 rounded-sm text-white text-[9px] font-bold flex items-center justify-center",
                          f.outcome === "loss" ? "bg-rose-500" : f.outcome === "draw" ? "bg-zinc-500" : "bg-emerald-500"
                        )}
                      >
                        {f.outcome === "bye" ? "B" : f.outcome === "win" ? "W" : f.outcome === "draw" ? "D" : "L"}
                      </span>
                    ))}
                    {(formById[row.id] ?? []).length === 0 && <span className="text-stone-400 text-xs">–</span>}
                  </div>
                </td>
                <td className="hidden sm:table-cell px-4 py-3 text-right font-mono-num text-stone-700">{row.wins}</td>
                <td className="hidden sm:table-cell px-4 py-3 text-right font-mono-num text-stone-700">{row.draws}</td>
                <td className="hidden sm:table-cell px-4 py-3 text-right font-mono-num text-stone-700">{row.losses}</td>
                {/* Score difference deliberately demoted to muted grey — points
                    are the standings' primary currency and should read first. */}
                <td className="px-3 sm:px-4 py-3 text-right font-mono-num text-stone-500">
                  {row.scoreDifference > 0 ? "+" : ""}{row.scoreDifference}
                </td>
                <td className="px-4 py-3 text-right bg-amber-400/5">
                  <span className="font-display font-bold text-lg text-amber-500">{row.leaguePoints}</span>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Flexible podium: 2 places (lower divisions), the classic 3, or 4 (Premier
// League) — winner always on the tallest step, arranged podium-style.
function Podium({ podium, participants }) {
  const n = podium.length;
  let order, heights;
  if (n >= 4) {
    order = [podium[1], podium[0], podium[2], podium[3]];
    heights = ["h-24", "h-32", "h-16", "h-12"];
  } else if (n === 3) {
    order = [podium[1], podium[0], podium[2]];
    heights = ["h-24", "h-32", "h-16"];
  } else if (n === 2) {
    order = [podium[0], podium[1]];
    heights = ["h-32", "h-24"];
  } else {
    order = [...podium];
    heights = ["h-32"];
  }
  const stepStyle = (place) =>
    place === 1 ? "bg-gradient-to-b from-amber-400/40 to-amber-400/10 text-amber-300 border border-amber-400/40"
      : place === 2 ? "bg-gradient-to-b from-zinc-400/30 to-zinc-400/5 text-stone-700 border border-zinc-500/40"
      : place === 3 ? "bg-gradient-to-b from-orange-500/30 to-orange-500/5 text-orange-300 border border-orange-500/40"
      : "bg-gradient-to-b from-sky-500/30 to-sky-500/5 text-sky-600 border border-sky-500/40";
  return (
    <div className="flex items-end justify-center gap-3 sm:gap-6 py-4">
      {order.map((row, i) => {
        if (!row) return <div key={i} className="w-24" />;
        const place = row.rank;
        const p = participants?.find((x) => x.id === row.id);
        return (
          <div key={row.id} className="flex flex-col items-center w-24 sm:w-28">
            {place === 1 && <Crown size={22} className="text-amber-400 mb-1" />}
            <div className="mb-1.5">
              <BadgeAvatar participant={p} name={row.name} size={44} />
            </div>
            <div className="font-medium text-sm text-center truncate w-full">{row.name}</div>
            <div className="font-mono-num text-xs text-stone-500 mb-2">{row.totalPoints} pts</div>
            <div className={cx(
              "w-full rounded-t-lg flex items-start justify-center pt-2 font-display font-bold text-lg",
              heights[i],
              stepStyle(place)
            )}>
              #{place}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -----------------------------------------------------------------------------
// PROFILES — contestants add their own photo, name, DOB, residence, supported
// team and a bio. Name and supported team are required; everything else,
// including the photo, is optional.
// -----------------------------------------------------------------------------

// Downscales an uploaded image in-browser (canvas) before it's stored, so
// profile photos don't bloat the shared save file. Returns a JPEG data URL.
function resizeImageFile(file, maxDim = 320) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function Avatar({ name, photo, size = 56 }) {
  if (photo) {
    return <img src={photo} alt={name} style={{ width: size, height: size }} className="rounded-full object-cover border border-stone-300" />;
  }
  const initials = (name || "?").trim().slice(0, 1).toUpperCase();
  return (
    <div
      style={{ width: size, height: size }}
      className="rounded-full bg-amber-400 text-black font-display font-bold flex items-center justify-center border border-amber-300"
    >
      {initials}
    </div>
  );
}

// Roster identity chip used in standings, podiums and pairing cards: the
// contestant's admin-uploaded team badge when one exists, otherwise a plain
// initial disc. Deliberately badge-first — badges are the site's visual
// identity for contestants; profile photos stay on the Profiles page only.
function BadgeAvatar({ participant, name, size = 26 }) {
  if (participant?.badge) {
    return (
      <img
        src={participant.badge}
        alt=""
        style={{ width: size, height: size }}
        className="rounded-full border border-stone-200 bg-white object-contain shrink-0"
      />
    );
  }
  return <Avatar name={name} size={size} />;
}

function ProfilesView({ league, leagueKey, data, viewerId, adminMode, persist }) {
  const fileInputRef = useRef(null);
  // Normally you can only ever edit your own profile. In admin mode there's
  // no "self" to default to, so admin explicitly picks who they're managing
  // from the roster — useful for setting a contestant up before they've
  // registered, or fixing something on their behalf.
  const [adminTargetId, setAdminTargetId] = useState("");
  const editTargetId = adminMode ? adminTargetId : viewerId;
  const participant = league.participants.find((p) => p.id === editTargetId);

  const [name, setName] = useState("");
  const [supports, setSupports] = useState("");
  const [dob, setDob] = useState("");
  const [residence, setResidence] = useState("");
  const [bio, setBio] = useState("");
  const [stadium, setStadium] = useState("");
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Contestants can only set their own stadium name before the season's
  // first matchday exists — once matchdays start, it's locked for them.
  // Admin can always change it, from here or from the roster.
  const stadiumLocked = !adminMode && league.matchdays.length > 0;

  useEffect(() => {
    setName(participant?.name ?? "");
    setSupports(participant?.supports ?? "");
    setDob(participant?.dob ?? "");
    setResidence(participant?.residence ?? "");
    setBio(participant?.bio ?? "");
    setStadium(participant?.stadium ?? "");
    setPhoto(participant?.photo ?? null);
    setError("");
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTargetId, league]);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImageFile(file, 320);
      setPhoto(dataUrl);
    } catch {
      setError("Couldn't read that image — try a different file.");
    }
  };

  const save = async () => {
    if (!editTargetId) { setError(adminMode ? "Choose a contestant to manage first." : "You're not registered in this league, so there's no profile to save."); return; }
    if (!name.trim() || !supports.trim()) { setError("Name and favourite team are required."); return; }
    setError("");
    const nextParticipants = league.participants.map((p) =>
      p.id === editTargetId
        ? { ...p, name: adminMode ? name.trim() : p.name, supports: supports.trim(), dob, residence: residence.trim(), bio: bio.trim(), photo: adminMode ? photo : p.photo, stadium: stadiumLocked ? p.stadium : stadium.trim() }
        : p
    );
    await persist({ ...data, leagues: { ...data.leagues, [leagueKey]: { ...league, participants: nextParticipants } } });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="space-y-8">
      {adminMode && (
        <div className="flex items-center gap-2 bg-white border border-stone-200 rounded-lg px-3 py-2">
          <ShieldCheck size={14} className="text-amber-400" />
          <span className="text-xs text-stone-500">Managing profile for</span>
          <select
            value={adminTargetId}
            onChange={(e) => setAdminTargetId(e.target.value)}
            className="bg-transparent text-sm text-stone-900 focus:outline-none"
          >
            <option value="">— choose a contestant —</option>
            {league.participants.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}

      {!editTargetId ? (
        <div className="flex items-center gap-2 bg-amber-400/10 border border-amber-400/30 text-amber-300 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={16} />
          {adminMode ? "Choose a contestant above to view or edit their profile." : `You're not a registered contestant in ${league.name}, so there's no profile to edit here.`}
        </div>
      ) : (
        <section className="bg-white border border-stone-200 rounded-2xl p-5">
          <h2 className="font-display font-semibold text-lg mb-4 flex items-center gap-2"><UserCircle2 size={18} className="text-amber-400" /> {adminMode ? `${participant?.name ?? ""}'s profile` : "Your profile"}</h2>

          {error && (
            <div className="flex items-center gap-2 bg-rose-50 border border-rose-300/30 text-rose-700 text-sm rounded-lg px-3 py-2 mb-4">
              <AlertCircle size={16} /> {error}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-6">
            <div className="flex flex-col items-center gap-2 shrink-0">
              {/* Profile photos are admin-managed: contestants see their
                  photo but only admin can upload, change, or remove it. */}
              {adminMode ? (
                <>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="relative group"
                    title="Upload a photo"
                  >
                    <Avatar name={name} photo={photo} size={88} />
                    <span className="absolute -bottom-1 -right-1 bg-amber-400 text-black rounded-full p-1.5 border-2 border-zinc-900 group-hover:bg-amber-300">
                      <Camera size={13} />
                    </span>
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
                  {photo && (
                    <button onClick={() => setPhoto(null)} className="text-xs text-stone-500 hover:text-rose-600">Remove photo</button>
                  )}
                  <span className="text-[11px] text-stone-500">Optional</span>
                </>
              ) : (
                <>
                  <Avatar name={name} photo={photo} size={88} />
                  <span className="text-[11px] text-stone-500 text-center max-w-[100px]">Photo is set by your organizer</span>
                </>
              )}
            </div>

            <div className="flex-1 grid sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-stone-500">Name <span className="text-amber-400">*</span></label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!adminMode}
                  className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50 disabled:opacity-50"
                />
                {!adminMode && <span className="text-[11px] text-stone-500">Set by your organizer — contact them to change it.</span>}
              </div>
              <div>
                <label className="text-xs text-stone-500 flex items-center gap-1"><Shirt size={12} /> Supports <span className="text-amber-400">*</span></label>
                <input value={supports} onChange={(e) => setSupports(e.target.value)} placeholder="e.g. Northgate United" className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
              </div>
              <div>
                <label className="text-xs text-stone-500 flex items-center gap-1"><Cake size={12} /> Date of birth</label>
                <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
                <span className="text-[11px] text-stone-500">Optional — kept off the public profile grid</span>
              </div>
              <div>
                <label className="text-xs text-stone-500 flex items-center gap-1"><MapPin size={12} /> Residence</label>
                <input value={residence} onChange={(e) => setResidence(e.target.value)} placeholder="e.g. Manchester" className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
                <span className="text-[11px] text-stone-500">Optional</span>
              </div>
              <div>
                <label className="text-xs text-stone-500 flex items-center gap-1"><Landmark size={12} /> Home stadium</label>
                <input
                  value={stadium}
                  onChange={(e) => setStadium(e.target.value)}
                  disabled={stadiumLocked}
                  placeholder="e.g. The Amara Arena"
                  className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50 disabled:opacity-50"
                />
                <span className="text-[11px] text-stone-500">
                  {stadiumLocked ? "Locked once the season's first matchday exists — set again at the start of the next season." : adminMode ? "Admin can set or change this any time." : "Optional — shown for your home fixtures. Editable until matchday 1."}
                </span>
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs text-stone-500">Bio</label>
                <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={400} rows={3} placeholder="A few lines about yourself…" className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
                <span className="text-[11px] text-stone-500">Optional — {400 - bio.length} characters left</span>
              </div>
            </div>
          </div>

          <button onClick={save} className="mt-5 flex items-center gap-2 bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm">
            {saved ? <CheckCircle2 size={16} /> : null} Save profile
          </button>
        </section>
      )}

      <section>
        <h2 className="font-display font-semibold text-lg mb-4 flex items-center gap-2"><Users size={18} className="text-amber-400" /> {league.name} squad</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {league.participants.map((p) => (
            <div key={p.id} className={cx("border rounded-2xl p-4 bg-white flex gap-3", p.id === editTargetId ? "border-amber-400/40" : "border-stone-200")}>
              <Avatar name={p.name} photo={p.photo} size={56} />
              <div className="min-w-0">
                <div className="font-display font-semibold truncate">{p.name}</div>
                <div className="text-xs text-amber-300 flex items-center gap-1 mt-0.5">
                  <Shirt size={12} /> {p.supports || <span className="text-stone-500 italic normal-case">no team set yet</span>}
                </div>
                {p.residence && (
                  <div className="text-xs text-stone-500 flex items-center gap-1 mt-0.5"><MapPin size={12} /> {p.residence}</div>
                )}
                {p.stadium && (
                  <div className="text-xs text-stone-500 flex items-center gap-1 mt-0.5"><Landmark size={12} /> {p.stadium}</div>
                )}
                {p.bio && <p className="text-xs text-stone-500 mt-2 leading-snug">{p.bio}</p>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// -----------------------------------------------------------------------------
// AUTH SCREEN — email + password login/registration (no third-party auth).
// Registering claims one of the admin-added, not-yet-claimed contestant
// names in a chosen league; that becomes your permanent identity in the
// app, so submitting predictions and editing your profile always maps back
// to the account you logged into rather than a free-form name picker.
// -----------------------------------------------------------------------------
function AuthScreen({ data, persist, onLogin, snapshots, onRestoreSnapshot, saveError, setSaveError }) {
  const [mode, setMode] = useState("login");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [enteringPin, setEnteringPin] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [adminLeagueKey, setAdminLeagueKey] = useState("league1");
  const [adminGlobalView, setAdminGlobalView] = useState(null); // null | "honours" | "history"

  const tryUnlock = () => {
    if (pin === data.adminPin) {
      setAdminUnlocked(true);
      setEnteringPin(false);
      setPinError("");
      setPin("");
    } else {
      setPinError("Wrong PIN");
    }
  };

  if (adminUnlocked) {
    const activeLeagueKeys = enabledLeagueKeys(data);
    const safeAdminLeagueKey = data.leagues[adminLeagueKey]?.enabled ? adminLeagueKey : (activeLeagueKeys[0] ?? "league1");
    const league = data.leagues[safeAdminLeagueKey];
    return (
      <div className="min-h-[700px] w-full bg-stone-100 text-stone-900" style={{ fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap');
          .font-display { font-family: 'Oswald', ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; }
          .font-score { font-family: 'Anton', ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.01em; }
          .font-mono-num { font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
        `}</style>
        <div style={{ background: "#3D1F5C" }} className="w-full px-4 pt-10 pb-6">
          <div className="max-w-5xl mx-auto space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <Logo className="h-14 w-auto object-contain" />
              <div className="flex items-center gap-2">
                <div className="flex gap-2 flex-wrap">
                  {activeLeagueKeys.map((k) => (
                    <button
                      key={k}
                      onClick={() => { setAdminLeagueKey(k); setAdminGlobalView(null); }}
                      className={cx(
                        "px-3 py-1.5 rounded-lg border text-xs font-display font-semibold",
                        !adminGlobalView && safeAdminLeagueKey === k ? "bg-amber-400 text-black border-amber-400" : "border-white/20 text-stone-200 hover:border-white/40"
                      )}
                    >
                      {data.leagues[k].name}
                    </button>
                  ))}
                  <button
                    onClick={() => setAdminGlobalView(adminGlobalView === "honours" ? null : "honours")}
                    className={cx(
                      "px-3 py-1.5 rounded-lg border text-xs font-display font-semibold flex items-center gap-1.5",
                      adminGlobalView === "honours" ? "bg-amber-400 text-black border-amber-400" : "border-amber-400/40 text-amber-300 hover:border-amber-400"
                    )}
                  >
                    <Trophy size={13} /> Honours
                  </button>
                  <button
                    onClick={() => setAdminGlobalView(adminGlobalView === "history" ? null : "history")}
                    className={cx(
                      "px-3 py-1.5 rounded-lg border text-xs font-display font-semibold flex items-center gap-1.5",
                      adminGlobalView === "history" ? "bg-amber-400 text-black border-amber-400" : "border-amber-400/40 text-amber-300 hover:border-amber-400"
                    )}
                  >
                    <History size={13} /> History
                  </button>
                </div>
                <button
                  onClick={() => setAdminUnlocked(false)}
                  className="flex items-center gap-1.5 border border-white/20 text-stone-200 hover:border-white/40 hover:text-white rounded-lg px-3 py-1.5 text-xs font-medium"
                >
                  <LogOut size={13} /> Exit admin
                </button>
              </div>
            </div>
            <p className="text-xs text-stone-300">
              Managing the roster here (before anyone's registered) — invite codes you generate can be sent out right away. Contestants use the <strong className="text-stone-100">Register</strong> screen with their code once you're ready.
            </p>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
          {saveError && (
            <div className="flex items-center gap-2 bg-rose-50 border border-rose-300 text-rose-700 text-sm rounded-lg px-4 py-2.5">
              <AlertCircle size={16} className="shrink-0" />
              <span className="flex-1">{saveError}</span>
              <button onClick={() => setSaveError(null)} className="text-rose-500 hover:text-rose-700 shrink-0"><X size={15} /></button>
            </div>
          )}
          {adminGlobalView === "honours" ? (
            <HonoursView data={data} adminMode persist={persist} />
          ) : adminGlobalView === "history" ? (
            <HistoryView data={data} adminMode persist={persist} />
          ) : (
            <AppTabs
              league={league}
              leagueKey={safeAdminLeagueKey}
              data={data}
              persist={persist}
              viewerId=""
              adminMode
              now={Date.now()}
              snapshots={snapshots}
              onRestoreSnapshot={onRestoreSnapshot}
              allowSubmit={false}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[700px] w-full bg-stone-100 text-stone-900 flex items-center justify-center px-4 py-12" style={{ fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap');
        .font-display { font-family: 'Oswald', ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; }
        .font-score { font-family: 'Anton', ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.01em; }
      `}</style>
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo className="h-28 w-auto object-contain" />
        </div>

        <div className="flex gap-1 mb-5 bg-white border border-stone-200 rounded-lg p-1">
          <button
            onClick={() => setMode("login")}
            className={cx("flex-1 py-2 rounded-md text-sm font-display font-semibold", mode === "login" ? "bg-amber-400 text-black" : "text-stone-500")}
          >
            Log in
          </button>
          <button
            onClick={() => setMode("register")}
            className={cx("flex-1 py-2 rounded-md text-sm font-display font-semibold", mode === "register" ? "bg-amber-400 text-black" : "text-stone-500")}
          >
            Register
          </button>
        </div>

        {mode === "login"
          ? <LoginForm data={data} persist={persist} onLogin={onLogin} />
          : <RegisterForm data={data} persist={persist} onLogin={onLogin} />}

        <div className="mt-6 pt-4 border-t border-stone-200 text-center">
          {enteringPin ? (
            <div className="flex items-center justify-center gap-2">
              <input
                autoFocus
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && tryUnlock()}
                placeholder="Admin PIN"
                className="bg-white border border-stone-300 rounded-lg px-3 py-1.5 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-violet-600/50"
              />
              <button onClick={tryUnlock} className="bg-stone-200 hover:bg-stone-300 border border-stone-300 rounded-lg px-3 py-1.5 text-sm font-medium">Unlock</button>
              <button onClick={() => { setEnteringPin(false); setPinError(""); }} className="text-stone-500 hover:text-stone-700"><X size={16} /></button>
            </div>
          ) : (
            <button onClick={() => setEnteringPin(true)} className="text-xs text-stone-500 hover:text-stone-700 flex items-center gap-1.5 mx-auto">
              <ShieldCheck size={13} /> Organizing this competition? Admin access
            </button>
          )}
          {pinError && <p className="text-xs text-rose-600 mt-2">{pinError}</p>}
        </div>
      </div>
    </div>
  );
}

function LoginForm({ data, persist, onLogin }) {
  const [view, setView] = useState("login"); // "login" | "reset"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNew, setConfirmNew] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    const key = email.trim().toLowerCase();
    if (!key || !password) { setError("Enter your email and password."); return; }
    setBusy(true);
    try {
      const account = data.accounts[key];
      if (!account) { setError("No account found for that email."); return; }
      const hash = await hashPassword(password, account.salt);
      if (hash !== account.hash) { setError("Incorrect password."); return; }
      const league = data.leagues[account.leagueKey];
      const participant = league?.participants.find((p) => p.id === account.participantId);
      if (!participant) { setError("Your linked contestant record is missing — ask the organizer to check the roster."); return; }
      onLogin({ email: key, name: participant.name, leagueKey: account.leagueKey, participantId: account.participantId });
    } finally {
      setBusy(false);
    }
  };

  // Uses the one-time reset code the organizer generated from the roster
  // (Admin → roster → "Reset password") to set a new password. The old
  // password stays valid right up until this succeeds, and the code is
  // consumed on use — it can't be replayed to change the password again.
  const submitReset = async () => {
    setError("");
    const key = email.trim().toLowerCase();
    const cleaned = resetCode.replace(/\s+/g, "").toUpperCase();
    if (!key) { setError("Enter your email address."); return; }
    if (!cleaned) { setError("Enter the reset code your organizer gave you."); return; }
    const account = data.accounts[key];
    if (!account) { setError("No account found for that email."); return; }
    if (!account.resetCode || account.resetCode !== cleaned) { setError("That reset code isn't right, or has already been used — ask your organizer to generate a new one."); return; }
    if (newPassword.length < 6) { setError("New password must be at least 6 characters."); return; }
    if (newPassword !== confirmNew) { setError("Passwords don't match."); return; }
    setBusy(true);
    try {
      const salt = randomSaltHex();
      const hash = await hashPassword(newPassword, salt);
      const { resetCode: _used, ...rest } = account;
      const ok = await persist({ ...data, accounts: { ...data.accounts, [key]: { ...rest, salt, hash } } });
      if (!ok) { setError("Couldn't save your new password — check your connection and try again."); return; }
      const league = data.leagues[account.leagueKey];
      const participant = league?.participants.find((p) => p.id === account.participantId);
      if (!participant) { setError("Password saved, but your contestant record is missing — ask the organizer to check the roster."); return; }
      onLogin({ email: key, name: participant.name, leagueKey: account.leagueKey, participantId: account.participantId });
    } finally {
      setBusy(false);
    }
  };

  if (view === "reset") {
    return (
      <div className="space-y-3">
        {error && (
          <div className="flex items-center gap-2 bg-rose-50 border border-rose-300/30 text-rose-700 text-sm rounded-lg px-3 py-2">
            <AlertCircle size={16} /> {error}
          </div>
        )}
        <p className="text-xs text-stone-500">
          Ask your organizer for a one-time reset code, then set a new password here. Your old password keeps working until you do.
        </p>
        <div className="relative">
          <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full bg-white border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <input
          value={resetCode}
          onChange={(e) => setResetCode(e.target.value)}
          placeholder="Reset code from your organizer"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck="false"
          className="w-full bg-white border border-stone-300 rounded-lg px-3 py-2.5 text-sm tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-violet-600/50"
        />
        <div className="relative">
          <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (6+ characters)" className="w-full bg-white border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <div className="relative">
          <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
          <input type="password" value={confirmNew} onChange={(e) => setConfirmNew(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitReset()} placeholder="Confirm new password" className="w-full bg-white border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
        </div>
        <button
          onClick={submitReset}
          disabled={busy}
          className="w-full bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-black font-display font-semibold rounded-lg py-2.5 text-sm"
        >
          {busy ? "Saving…" : "Set new password & log in"}
        </button>
        <button onClick={() => { setView("login"); setError(""); }} className="w-full text-xs text-stone-500 hover:text-stone-700 py-1">
          Back to log in
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-center gap-2 bg-rose-50 border border-rose-300/30 text-rose-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      <div className="relative">
        <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Email"
          className="w-full bg-white border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
        />
      </div>
      <div className="relative">
        <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Password"
          className="w-full bg-white border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
        />
      </div>
      <button
        onClick={submit}
        disabled={busy}
        className="w-full bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-black font-display font-semibold rounded-lg py-2.5 text-sm"
      >
        {busy ? "Signing in…" : "Log in"}
      </button>
      <button onClick={() => { setView("reset"); setError(""); }} className="w-full text-xs text-stone-500 hover:text-stone-700 py-1">
        Forgotten your password?
      </button>
    </div>
  );
}

// Looks up which (unclaimed) contestant a code belongs to, across both
// leagues. Returns null if the code is unknown or already used.
function resolveInviteCode(data, rawCode, claimedIds) {
  // Strip ALL whitespace (not just leading/trailing) before comparing —
  // invite codes never legitimately contain spaces, so this only ever
  // rescues a genuine code from a stray space a mobile keyboard, autofill,
  // or copy-paste might have introduced.
  const code = rawCode.replace(/\s+/g, "").toUpperCase();
  if (!code) return null;
  for (const leagueKey of enabledLeagueKeys(data)) {
    const participant = data.leagues[leagueKey].participants.find((p) => p.code === code);
    if (participant && !claimedIds.has(participant.id)) {
      return { leagueKey, participant };
    }
  }
  return null;
}

function RegisterForm({ data, persist, onLogin }) {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const claimedIds = useMemo(() => new Set(Object.values(data.accounts).map((a) => a.participantId)), [data.accounts]);
  const resolved = useMemo(() => resolveInviteCode(data, code, claimedIds), [data, code, claimedIds]);

  const submit = async () => {
    setError("");
    const key = email.trim().toLowerCase();
    if (!resolved) { setError("Enter the invite code your organizer gave you."); return; }
    if (!EMAIL_RE.test(key)) { setError("Enter a valid email address."); return; }
    if (data.accounts[key]) { setError("An account with that email already exists — try logging in instead."); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }

    setBusy(true);
    try {
      const salt = randomSaltHex();
      const hash = await hashPassword(password, salt);
      const { leagueKey, participant } = resolved;
      const nextAccounts = { ...data.accounts, [key]: { email: key, salt, hash, leagueKey, participantId: participant.id } };
      await persist({ ...data, accounts: nextAccounts });
      onLogin({ email: key, name: participant.name, leagueKey, participantId: participant.id });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-center gap-2 bg-rose-50 border border-rose-300/30 text-rose-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      <div>
        <label className="text-xs text-stone-500">Invite code</label>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. 7K3PXM"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck="false"
          className="w-full mt-1 bg-white border border-stone-300 rounded-lg px-3 py-2.5 text-sm tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-violet-600/50"
        />
        {code.trim() && (
          resolved ? (
            <p className="text-xs text-emerald-700 mt-1 flex items-center gap-1">
              <CheckCircle2 size={12} /> Registering as <strong>{resolved.participant.name}</strong> — {data.leagues[resolved.leagueKey].name}
            </p>
          ) : (
            <p className="text-xs text-rose-700 mt-1">That code isn't recognized, or it's already been used. Check with your organizer.</p>
          )
        )}
        <p className="text-[11px] text-stone-500 mt-1">Ask your organizer for your personal invite code — this confirms the name you're registering is really yours.</p>
      </div>

      <div className="relative">
        <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full bg-white border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
      </div>
      <div className="relative">
        <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (6+ characters)" className="w-full bg-white border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
      </div>
      <div className="relative">
        <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm password" className="w-full bg-white border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50" />
      </div>

      <button
        onClick={submit}
        disabled={busy || !resolved}
        className="w-full bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-black font-display font-semibold rounded-lg py-2.5 text-sm"
      >
        {busy ? "Creating account…" : "Create account"}
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// STATS — per-contestant performance profiles plus two position-history
// graphs (one per league), both built entirely from published matchday
// results so nothing here ever leaks results ahead of the admin's publish
// step.
// -----------------------------------------------------------------------------

// A distinct color per participant, spread evenly around the color wheel —
// works for any roster size up to the 20-per-league cap.
function colorForIndex(i, total) {
  const hue = Math.round((i * 360) / Math.max(total, 1)) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

// All the numbers for one contestant's Stats Profile, computed from every
// published matchday to date.
function computeContestantStats(participant, league, predictions) {
  const pubs = publishedMatchdays(league);
  let totalPoints = 0, matchesEvaluated = 0, matchesPredicted = 0;
  let correctResults = 0, exactScorelines = 0;
  let sumHome = 0, sumAway = 0, goalPredictionCount = 0;
  const matchdayPoints = [];
  const matchResultsChrono = [];

  pubs.forEach((md) => {
    let mdPoints = 0;
    effectiveMatchesFor(md, participant.id).forEach((m) => {
      if (!m.outcome) return;
      const pred = predictions[`${m.id}__${participant.id}`];
      const result = scoreMatch(m, pred, md.scoring);
      if (result.evaluated) {
        matchesEvaluated += 1;
        totalPoints += result.points;
        mdPoints += result.points;
        if (result.correct) correctResults += 1;
        matchResultsChrono.push(result.correct);
      }
      if (pred) {
        matchesPredicted += 1;
        sumHome += pred.home;
        sumAway += pred.away;
        goalPredictionCount += 1;
        if (pred.home === m.outcome.home && pred.away === m.outcome.away) exactScorelines += 1;
      }
    });
    matchdayPoints.push({ id: md.id, label: md.label, points: Math.round(mdPoints * 10) / 10 });
  });

  let best = null, worst = null;
  matchdayPoints.forEach((mp) => {
    if (!best || mp.points > best.points) best = mp;
    if (!worst || mp.points < worst.points) worst = mp;
  });

  let currentStreak = 0;
  for (let i = matchResultsChrono.length - 1; i >= 0; i--) {
    if (matchResultsChrono[i]) currentStreak += 1;
    else break;
  }
  let longestStreak = 0, run = 0;
  matchResultsChrono.forEach((correct) => {
    if (correct) { run += 1; longestStreak = Math.max(longestStreak, run); }
    else run = 0;
  });

  const round1 = (n) => Math.round(n * 10) / 10;
  const round2 = (n) => Math.round(n * 100) / 100;

  const h2h = computeLeaderboardWithPredictions(league.participants, pubs, predictions, league.adjustments).find((r) => r.id === participant.id);

  return {
    totalPoints: round1(totalPoints),
    matchdaysPlayed: matchdayPoints.length,
    matchesEvaluated,
    matchesPredicted,
    correctResults,
    accuracy: matchesEvaluated > 0 ? round1((correctResults / matchesEvaluated) * 100) : null,
    exactScorelines,
    avgPointsPerMatchday: matchdayPoints.length > 0 ? round2(totalPoints / matchdayPoints.length) : null,
    avgPointsPerMatch: matchesEvaluated > 0 ? round2(totalPoints / matchesEvaluated) : null,
    avgGoalsHome: goalPredictionCount > 0 ? round2(sumHome / goalPredictionCount) : null,
    avgGoalsAway: goalPredictionCount > 0 ? round2(sumAway / goalPredictionCount) : null,
    avgGoalsTotal: goalPredictionCount > 0 ? round2((sumHome + sumAway) / goalPredictionCount) : null,
    best,
    worst,
    currentStreak,
    longestStreak,
    matchdayPoints,
    // Head-to-head record — the table points, not the raw prediction score above.
    leaguePoints: h2h?.leaguePoints ?? 0,
    leagueRank: h2h?.rank ?? null,
    wins: h2h?.wins ?? 0,
    draws: h2h?.draws ?? 0,
    losses: h2h?.losses ?? 0,
    scoreDifference: h2h?.scoreDifference ?? 0,
  };
}

// One row per published matchday, with every participant's actual table
// rank at that point in the season — reuses the real standings calculation
// for each prefix of matchdays so this always matches the live table's
// tiebreak logic exactly.
function computeRankHistory(league, predictions) {
  const pubs = publishedMatchdays(league);
  return pubs.map((md, idx) => {
    const board = computeLeaderboardWithPredictions(league.participants, pubs.slice(0, idx + 1), predictions, league.adjustments);
    const row = { matchday: idx + 1, label: md.label };
    board.forEach((r) => { row[r.id] = r.rank; });
    return row;
  });
}

function RankHistoryChart({ league, leagueKey, predictions, highlightId }) {
  const rows = useMemo(() => computeRankHistory(league, predictions), [league, predictions]);
  const maxX = league.h2hSchedule.length || Math.max(league.matchdays.length, 1);
  const maxY = league.maxParticipants || DEFAULT_MAX_PARTICIPANTS;

  if (rows.length === 0) {
    return (
      <div className="border border-stone-200 rounded-2xl p-8 text-center text-sm text-stone-500">
        No published matchdays yet — this graph fills in as results are confirmed.
      </div>
    );
  }

  return (
    <div className="border border-stone-200 rounded-2xl p-4 bg-white" style={{ height: 360 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 10, right: 20, left: 0, bottom: 24 }}>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
          <XAxis
            dataKey="matchday"
            type="number"
            domain={[1, maxX]}
            allowDecimals={false}
            stroke="#a1a1aa"
            tick={{ fontSize: 11 }}
            label={{ value: "Matchday", position: "bottom", offset: 10, fill: "#71717a", fontSize: 11 }}
          />
          <YAxis
            reversed
            domain={[1, maxY]}
            allowDecimals={false}
            stroke="#a1a1aa"
            tick={{ fontSize: 11 }}
            label={{ value: "Position", angle: -90, position: "insideLeft", fill: "#71717a", fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 12 }}
            labelFormatter={(v) => `Matchday ${v}`}
          />
          {!highlightId && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {league.participants.map((p, i) => {
            const isHighlighted = highlightId === p.id;
            const color = highlightId ? (isHighlighted ? "#fbbf24" : "#52525b") : colorForIndex(i, league.participants.length);
            return (
              <Line
                key={p.id}
                dataKey={p.id}
                name={p.name}
                stroke={color}
                strokeWidth={highlightId ? (isHighlighted ? 3 : 1) : 2}
                isAnimationActive={false}
                dot={(dotProps) => {
                  if (dotProps.index !== rows.length - 1) return <React.Fragment key={`${p.id}-${dotProps.index}`} />;
                  const r = 12;
                  return (
                    <g key={`${p.id}-badge`}>
                      <circle cx={dotProps.cx} cy={dotProps.cy} r={r} fill={p.badge ? "#fff" : color} stroke="#000" strokeWidth={1.5} />
                      {p.badge ? (
                        <>
                          <clipPath id={`badge-clip-${p.id}`}>
                            <circle cx={dotProps.cx} cy={dotProps.cy} r={r - 1.5} />
                          </clipPath>
                          <image
                            href={p.badge}
                            x={dotProps.cx - r + 1.5}
                            y={dotProps.cy - r + 1.5}
                            width={(r - 1.5) * 2}
                            height={(r - 1.5) * 2}
                            clipPath={`url(#badge-clip-${p.id})`}
                            preserveAspectRatio="xMidYMid slice"
                          />
                        </>
                      ) : (
                        <text x={dotProps.cx} y={dotProps.cy + 4} textAnchor="middle" fontSize={10} fontWeight="700" fill="#000">
                          {p.name.slice(0, 1).toUpperCase()}
                        </text>
                      )}
                    </g>
                  );
                }}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// One contestant's record against every opponent they've actually faced,
// built from published matchdays only. Byes aren't meetings, so they don't
// appear here.
function computeH2HRecords(participantId, league, predictions) {
  const records = {}; // opponentId -> { wins, draws, losses, pointsFor, pointsAgainst, meetings: [] }
  publishedMatchdays(league).forEach((md) => {
    const res = computeH2HResultsForMatchday(md, predictions, league.participants);
    const r = res[participantId];
    if (!r || !r.opponentId) return;
    const rec = records[r.opponentId] ?? (records[r.opponentId] = { wins: 0, draws: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, meetings: [] });
    if (r.outcome === "win") rec.wins += 1;
    else if (r.outcome === "loss") rec.losses += 1;
    else rec.draws += 1;
    rec.pointsFor += r.ownRaw ?? 0;
    rec.pointsAgainst += r.opponentRaw ?? 0;
    rec.meetings.push({ md: md.label, outcome: r.outcome, ownRaw: r.ownRaw, opponentRaw: r.opponentRaw });
  });
  return records;
}

// Head-to-head records on a contestant's stats profile: a summary table
// against every opponent faced so far, plus a picker to zoom into one
// rivalry — full record, prediction points for/against, and every meeting
// listed matchday by matchday.
function H2HRecordsSection({ participant, league, predictions }) {
  const [opponentId, setOpponentId] = useState("");
  const records = useMemo(() => computeH2HRecords(participant.id, league, predictions), [participant.id, league, predictions]);
  const nameById = Object.fromEntries(league.participants.map((p) => [p.id, p.name]));
  const opponents = league.participants.filter((p) => p.id !== participant.id);
  const faced = opponents.filter((o) => records[o.id]);
  const selected = opponentId ? records[opponentId] : null;

  const outcomeChip = (outcome) => (
    <span className={cx(
      "w-4 h-4 rounded-sm text-white text-[9px] font-bold inline-flex items-center justify-center shrink-0",
      outcome === "win" ? "bg-emerald-500" : outcome === "loss" ? "bg-rose-500" : "bg-zinc-500"
    )}>
      {outcome === "win" ? "W" : outcome === "loss" ? "L" : "D"}
    </span>
  );

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <h3 className="font-display font-semibold text-sm">Head-to-head records</h3>
        <select
          value={opponentId}
          onChange={(e) => setOpponentId(e.target.value)}
          className="bg-white border border-stone-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600/50"
        >
          <option value="">All opponents</option>
          {opponents.map((o) => <option key={o.id} value={o.id}>vs {o.name}</option>)}
        </select>
      </div>

      {opponentId === "" ? (
        faced.length === 0 ? (
          <p className="text-xs text-stone-500">No head-to-head meetings published yet — records appear as matchdays are confirmed.</p>
        ) : (
          <div className="border border-stone-200 rounded-2xl bg-white overflow-hidden">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-4 py-2 font-semibold">Opponent</th>
                  <th className="px-3 py-2 font-semibold text-center">P</th>
                  <th className="px-3 py-2 font-semibold text-center">W-D-L</th>
                  <th className="hidden sm:table-cell px-3 py-2 font-semibold text-right">Pts for–against</th>
                </tr>
              </thead>
              <tbody>
                {faced.map((o) => {
                  const rec = records[o.id];
                  return (
                    <tr key={o.id} className="border-t border-stone-100">
                      <td className="px-4 py-2.5">
                        <button onClick={() => setOpponentId(o.id)} className="font-medium hover:text-violet-700 hover:underline text-left">
                          {o.name}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono-num text-stone-500">{rec.meetings.length}</td>
                      <td className="px-3 py-2.5 text-center font-mono-num">{rec.wins}-{rec.draws}-{rec.losses}</td>
                      <td className="hidden sm:table-cell px-3 py-2.5 text-right font-mono-num text-stone-500">{rec.pointsFor}–{rec.pointsAgainst}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : !selected ? (
        <p className="text-xs text-stone-500">{participant.name} hasn't faced {nameById[opponentId] ?? "?"} yet this season.</p>
      ) : (
        <div className="border border-stone-200 rounded-2xl bg-white p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <div className="text-[11px] text-stone-500 uppercase tracking-wide">{participant.name} v {nameById[opponentId] ?? "?"}</div>
              <div className="font-display font-bold text-2xl">{selected.wins}–{selected.draws}–{selected.losses}</div>
              <div className="text-[11px] text-stone-500">W–D–L</div>
            </div>
            <div>
              <div className="text-[11px] text-stone-500 uppercase tracking-wide">Prediction points</div>
              <div className="font-mono-num text-lg">{selected.pointsFor}–{selected.pointsAgainst}</div>
              <div className="text-[11px] text-stone-500">for–against</div>
            </div>
          </div>
          <div className="space-y-1.5">
            {selected.meetings.map((mt, i) => (
              <div key={i} className="flex items-center gap-2 text-xs border-t border-stone-100 pt-1.5">
                {outcomeChip(mt.outcome)}
                <span className="text-stone-500 w-28 shrink-0">{mt.md}</span>
                <span className="font-mono-num">{mt.ownRaw}–{mt.opponentRaw}</span>
                <span className="text-stone-500">
                  {mt.outcome === "win" ? "won" : mt.outcome === "loss" ? "lost" : "drew"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ icon: Icon, label, value, sub }) {
  return (
    <div className="border border-stone-200 rounded-xl p-3 bg-stone-50">
      <div className="flex items-center gap-1.5 text-[11px] text-stone-500 uppercase tracking-wide mb-1">
        <Icon size={12} /> {label}
      </div>
      <div className="font-mono-num text-lg font-semibold text-amber-300">{value}</div>
      {sub && <div className="text-[11px] text-stone-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function StatsProfileView({ participant, league, leagueKey, data, onBack }) {
  const stats = useMemo(() => computeContestantStats(participant, league, data.predictions), [participant, league, data.predictions]);

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900">
        <ArrowLeft size={15} /> Back to {league.name} stats
      </button>

      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <Avatar name={participant.name} photo={participant.photo} size={64} />
          {participant.badge && (
            <img src={participant.badge} alt="" className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full border-2 border-black bg-white object-contain" />
          )}
        </div>
        <div>
          <h2 className="font-display font-bold text-2xl">{participant.name}</h2>
          {participant.supports && <p className="text-xs text-amber-300 flex items-center gap-1 mt-1"><Shirt size={12} /> Supports {participant.supports}</p>}
        </div>
      </div>

      {stats.matchdaysPlayed === 0 ? (
        <p className="text-sm text-stone-500">No published results yet for this contestant — stats will populate as matchdays are confirmed.</p>
      ) : (
        <>
          <div className="border border-amber-400/20 bg-amber-400/5 rounded-xl p-4 flex flex-wrap items-center gap-4">
            <div>
              <div className="text-[11px] text-amber-300 uppercase tracking-wide">League position</div>
              <div className="font-display font-bold text-2xl">#{stats.leagueRank ?? "—"}</div>
            </div>
            <div>
              <div className="text-[11px] text-stone-500 uppercase tracking-wide">Record (W-D-L)</div>
              <div className="font-mono-num text-lg">{stats.wins}-{stats.draws}-{stats.losses}</div>
            </div>
            <div>
              <div className="text-[11px] text-stone-500 uppercase tracking-wide">Score difference</div>
              <div className={cx("font-mono-num text-lg", stats.scoreDifference > 0 ? "text-emerald-600" : stats.scoreDifference < 0 ? "text-rose-600" : "text-stone-700")}>
                {stats.scoreDifference > 0 ? "+" : ""}{stats.scoreDifference}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-stone-500 uppercase tracking-wide">League points</div>
              <div className="font-mono-num text-lg text-amber-300 font-semibold">{stats.leaguePoints}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile icon={Trophy} label="Predicted points" value={stats.totalPoints} sub={`raw score over ${stats.matchdaysPlayed} matchday${stats.matchdaysPlayed === 1 ? "" : "s"}`} />
            <StatTile icon={BarChart3} label="Avg pts / matchday" value={stats.avgPointsPerMatchday} />
            <StatTile icon={Target} label="Avg pts / match" value={stats.avgPointsPerMatch} />
            <StatTile icon={CheckCircle2} label="Result accuracy" value={stats.accuracy !== null ? `${stats.accuracy}%` : "—"} sub={`${stats.correctResults}/${stats.matchesEvaluated} correct`} />
            <StatTile icon={Award} label="Exact scorelines" value={stats.exactScorelines} />
            <StatTile icon={Send} label="Predictions made" value={stats.matchesPredicted} sub={`of ${stats.matchesEvaluated} matches`} />
            <StatTile icon={Flame} label="Current streak" value={`${stats.currentStreak} correct`} sub={`best run: ${stats.longestStreak}`} />
            <StatTile icon={BarChart3} label="Avg goals predicted" value={stats.avgGoalsTotal ?? "—"} sub={stats.avgGoalsHome !== null ? `${stats.avgGoalsHome} home · ${stats.avgGoalsAway} away` : undefined} />
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="border border-emerald-300/20 bg-emerald-50 rounded-xl p-3">
              <div className="text-[11px] text-emerald-700 uppercase tracking-wide mb-1">Best matchday</div>
              <div className="font-medium">{stats.best?.label ?? "—"}</div>
              <div className="font-mono-num text-emerald-700 text-sm">{stats.best?.points ?? 0} pts</div>
            </div>
            <div className="border border-rose-300/20 bg-rose-50 rounded-xl p-3">
              <div className="text-[11px] text-rose-700 uppercase tracking-wide mb-1">Toughest matchday</div>
              <div className="font-medium">{stats.worst?.label ?? "—"}</div>
              <div className="font-mono-num text-rose-700 text-sm">{stats.worst?.points ?? 0} pts</div>
            </div>
          </div>

          <H2HRecordsSection participant={participant} league={league} predictions={data.predictions} />
        </>
      )}

      <div>
        <h3 className="font-display font-semibold text-sm mb-2">Position through the season</h3>
        <RankHistoryChart league={league} leagueKey={leagueKey} predictions={data.predictions} highlightId={participant.id} />
      </div>
    </div>
  );
}

function StatsView({ league, leagueKey, data }) {
  const [selectedId, setSelectedId] = useState(null);
  const board = useMemo(() => computeLeaderboardWithPredictions(league.participants, publishedMatchdays(league), data.predictions, league.adjustments), [league, data.predictions]);
  const selected = selectedId ? league.participants.find((p) => p.id === selectedId) : null;

  if (selected) {
    return <StatsProfileView participant={selected} league={league} leagueKey={leagueKey} data={data} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="space-y-6">
      <h2 className="font-display font-semibold text-lg flex items-center gap-2"><TrendingUp size={18} className="text-amber-400" /> {league.name} stats</h2>

      <div>
        <h3 className="font-display font-semibold text-sm mb-2">Position through the season</h3>
        <RankHistoryChart league={league} leagueKey={leagueKey} predictions={data.predictions} />
      </div>

      <div>
        <h3 className="font-display font-semibold text-sm mb-2">Contestants</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {board.map((row) => {
            const participant = league.participants.find((p) => p.id === row.id);
            return (
              <button
                key={row.id}
                onClick={() => setSelectedId(row.id)}
                className="flex items-center gap-3 border border-stone-200 rounded-xl p-3 bg-white hover:border-amber-400/40 text-left transition-colors"
              >
                <div className="relative shrink-0">
                  <Avatar name={participant.name} photo={participant.photo} size={40} />
                  {participant.badge && (
                    <img src={participant.badge} alt="" className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-2 border-black bg-white object-contain" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{participant.name}</div>
                  <div className="text-xs text-stone-500 font-mono-num">#{row.rank} · {row.leaguePoints} pts ({row.wins}-{row.draws}-{row.losses})</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
