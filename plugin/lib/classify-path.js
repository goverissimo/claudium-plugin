// SPDX-License-Identifier: Apache-2.0
// lib/classify-path.js — D4: pure predicate answering "does this path belong
// to lib/classify-headless.js's `claude -p` child's own project dir
// (~/.tokenomica/classify)?" That child is itself a Claude Code session, so it
// writes its own transcript under a project dir Claude Code derives from its
// cwd — every route that walks or tails Claude Code session files must skip
// it, or the classifier's own session feeds right back into the pipeline it
// exists to classify (lib/watcher.js's live tail, lib/usage-pipeline.js's
// watchUsage/buildRecordForFile, and plugin/upload-session.js's backfill
// walk). ONE predicate, not a copy per call site — vendor-safe (node
// builtins only, no chokidar) so it can be vendored into plugin/lib/ by
// scripts/build-plugin.js and required from plugin source directly.
//
// Claude Code encodes a session's cwd into its project folder name by
// replacing EVERY non-alphanumeric character with '-' — path separators AND
// the leading dot both become dashes. So '/Users/x/.tokenomica/classify'
// becomes '-Users-x--tokenomica-classify': note the DOUBLE dash where the '/'
// before '.tokenomica' and the '.' itself collide. A regex anchored on a
// literal '.' before 'tokenomica' (the raw-path form) never matches this
// encoded form — the dot never survives encoding.
//
// Matches the dash-encoded production form as well as raw absolute paths on
// both POSIX ('/') and Windows ('\') separators — deliberately loose (any
// separator-class character around 'tokenomica'/'classify'), not a single
// exact string, since re-deriving Claude Code's encoding from the outside is
// easy to get subtly wrong.
const CLASSIFY_DIR_RE = /[-./\\]tokenomica[-/\\]classify/;
const isClassifyProjectPath = (filepath) => CLASSIFY_DIR_RE.test(String(filepath || ''));

module.exports = { isClassifyProjectPath, CLASSIFY_DIR_RE };
