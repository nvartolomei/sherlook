import { describe, it, expect } from 'vitest'
import { computeInterdiff } from './interdiff'

// Real-world test from redpanda PR #29831: a force push that moves
// a maybe_repair_manifest() call from one location to another.
// The first hunk (adding the function definition) is identical in both patches.
// The second hunk (adding the call site) is at a different position.

const patchA = `diff --git a/src/v/cluster/archival/ntp_archiver_service.cc b/src/v/cluster/archival/ntp_archiver_service.cc
index 765f767b7d871..fe1ca02b4e2eb 100644
--- a/src/v/cluster/archival/ntp_archiver_service.cc
+++ b/src/v/cluster/archival/ntp_archiver_service.cc
@@ -418,6 +418,40 @@ archival_stm_fence ntp_archiver::emit_rw_fence() {
     };
 }

+ss::future<std::error_code>
+ntp_archiver::maybe_repair_manifest(ss::lowres_clock::time_point deadline) {
+    auto repaired_copy = _parent.archival_meta_stm()->manifest().repair_state();
+    if (!repaired_copy) {
+        co_return std::error_code{};
+    }
+
+    vlog(
+      _rtclog.warn, "Manifest repair created a new manifest. Replicating it.");
+    auto batch = _parent.archival_meta_stm()->batch_start(deadline, _as);
+    auto fence = emit_rw_fence();
+    if (fence.emit_rw_fence_cmd) {
+        vlog(
+          _rtclog.debug,
+          "replace manifest with repair, read-write fence: {}",
+          fence.read_write_fence);
+        batch.read_write_fence(fence.read_write_fence);
+    }
+
+    batch.replace_manifest(repaired_copy->to_iobuf());
+    auto ec = co_await batch.replicate();
+    if (ec) {
+        vlog(
+          _rtclog.error,
+          "Failed to replace manifest with repaired version: {}",
+          ec);
+    } else {
+        vlog(
+          _rtclog.debug, "Finished replacing manifest with repaired version");
+    }
+
+    co_return ec;
+}
+
 void ntp_archiver::log_collected_traces() noexcept {
     try {
         _rtclog.bypass_tracing([this] {
@@ -637,6 +671,13 @@ ss::future<> ntp_archiver::upload_until_abort() {
             continue;
         }

+        if (auto ec = co_await maybe_repair_manifest(
+              ss::lowres_clock::now() + sync_timeout);
+            ec) {
+            vlog(_rtclog.warn, "Failed to repair manifest: {}, retrying", ec);
+            continue;
+        }
+
         replica_state_validator validator(
           *_parent.log(), _parent.archival_meta_stm()->manifest());
         if (validator.has_anomalies()) {
`

const patchB = `diff --git a/src/v/cluster/archival/ntp_archiver_service.cc b/src/v/cluster/archival/ntp_archiver_service.cc
index 765f767b7d871..f474a91cfc9e7 100644
--- a/src/v/cluster/archival/ntp_archiver_service.cc
+++ b/src/v/cluster/archival/ntp_archiver_service.cc
@@ -418,6 +418,40 @@ archival_stm_fence ntp_archiver::emit_rw_fence() {
     };
 }

+ss::future<std::error_code>
+ntp_archiver::maybe_repair_manifest(ss::lowres_clock::time_point deadline) {
+    auto repaired_copy = _parent.archival_meta_stm()->manifest().repair_state();
+    if (!repaired_copy) {
+        co_return std::error_code{};
+    }
+
+    vlog(
+      _rtclog.warn, "Manifest repair created a new manifest. Replicating it.");
+    auto batch = _parent.archival_meta_stm()->batch_start(deadline, _as);
+    auto fence = emit_rw_fence();
+    if (fence.emit_rw_fence_cmd) {
+        vlog(
+          _rtclog.debug,
+          "replace manifest with repair, read-write fence: {}",
+          fence.read_write_fence);
+        batch.read_write_fence(fence.read_write_fence);
+    }
+
+    batch.replace_manifest(repaired_copy->to_iobuf());
+    auto ec = co_await batch.replicate();
+    if (ec) {
+        vlog(
+          _rtclog.error,
+          "Failed to replace manifest with repaired version: {}",
+          ec);
+    } else {
+        vlog(
+          _rtclog.debug, "Finished replacing manifest with repaired version");
+    }
+
+    co_return ec;
+}
+
 void ntp_archiver::log_collected_traces() noexcept {
     try {
         _rtclog.bypass_tracing([this] {
@@ -698,6 +732,13 @@ ss::future<> ntp_archiver::upload_until_abort() {
             }
         }

+        if (auto ec = co_await maybe_repair_manifest(
+              ss::lowres_clock::now() + sync_timeout);
+            ec) {
+            vlog(_rtclog.warn, "Failed to repair manifest: {}, retrying", ec);
+            continue;
+        }
+
         vlog(_rtclog.debug, "upload loop synced in term {}", _start_term);
         if (!may_begin_uploads()) {
             continue;
`

// Expected content lines from: interdiff <(git diff dev...17e4570) <(git diff dev...0d1e22cf0b)
// (excluding diff/@@  headers; blank context lines have a space prefix)
const expectedLines = [
  '             continue;',
  '         }',
  ' ',
  '-        if (auto ec = co_await maybe_repair_manifest(',
  '-              ss::lowres_clock::now() + sync_timeout);',
  '-            ec) {',
  '-            vlog(_rtclog.warn, "Failed to repair manifest: {}, retrying", ec);',
  '-            continue;',
  '-        }',
  '-',
  '         replica_state_validator validator(',
  '           *_parent.log(), _parent.archival_meta_stm()->manifest());',
  '         if (validator.has_anomalies()) {',
  '             }',
  '         }',
  ' ',
  '+        if (auto ec = co_await maybe_repair_manifest(',
  '+              ss::lowres_clock::now() + sync_timeout);',
  '+            ec) {',
  '+            vlog(_rtclog.warn, "Failed to repair manifest: {}, retrying", ec);',
  '+            continue;',
  '+        }',
  '+',
  '         vlog(_rtclog.debug, "upload loop synced in term {}", _start_term);',
  '         if (!may_begin_uploads()) {',
  '             continue;',
]

describe('PR 29831: moved maybe_repair_manifest call', () => {
  it('matches interdiff tool output', () => {
    const result = computeInterdiff(patchA, patchB)
    const lines = result.split('\n')

    // Should have the file header
    expect(lines[0]).toContain('ntp_archiver_service.cc')

    // The first hunk (function definition at @@ -418) is identical → not in output
    expect(result).not.toContain('maybe_repair_manifest(ss::lowres_clock::time_point')

    // All content lines (adds, dels, context) must match interdiff tool exactly
    const actual = lines.filter(l => l.startsWith('+') || l.startsWith('-') || l.startsWith(' '))
    expect(actual).toEqual(expectedLines)
  })
})
