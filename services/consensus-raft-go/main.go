// appendLogFromLeaderLocked appends replicated entries after checking
// consistency with the previous log entry.
//
// The caller must hold rn.mu.
func (rn *RaftNode) appendLogFromLeaderLocked(
	req AppendEntriesRequest,
) bool {

	// A leader cannot reference an index older than the follower's
	// compacted snapshot.
	if req.PrevLogIndex < rn.snapshotIndex {
		return false
	}

	// The snapshot boundary itself is a valid previous-log position.
	if req.PrevLogIndex == rn.snapshotIndex {
		if req.PrevLogTerm != rn.snapshotTerm {
			return false
		}
	} else {
		idx := rn.logIndex(req.PrevLogIndex)

		// IMPORTANT:
		// Never index rn.Log without checking the calculated slice index.
		if idx < 0 || idx >= len(rn.Log) {
			return false
		}

		if rn.Log[idx].Term != req.PrevLogTerm {
			return false
		}
	}

	// Nothing to append. The prefix matched successfully.
	if len(req.Entries) == 0 {
		return true
	}

	originalLog := append([]LogEntry(nil), rn.Log...)

	for i, entry := range req.Entries {
		if entry.Index <= rn.snapshotIndex {
			continue
		}

		idx := rn.logIndex(entry.Index)

		if idx < 0 {
			return false
		}

		// Existing entry.
		if idx < len(rn.Log) {
			if rn.Log[idx].Term == entry.Term {
				// Entry already matches. Continue checking subsequent
				// entries.
				continue
			}

			// Conflicting entry:
			// truncate the follower's conflicting suffix and append
			// the leader's entries from this point onward.
			rn.Log = rn.Log[:idx]
			rn.Log = append(rn.Log, req.Entries[i:]...)

			if err := rn.persister.SaveLog(rn.Log); err != nil {
				rn.Log = originalLog
				log.Printf(
					"raft persist error while replacing conflicting suffix: %v",
					err,
				)
				return false
			}

			return true
		}

		// The follower is missing this entry and everything after it.
		rn.Log = append(rn.Log, req.Entries[i:]...)

		if err := rn.persister.SaveLog(rn.Log); err != nil {
			rn.Log = originalLog
			log.Printf(
				"raft persist error while appending replicated entries: %v",
				err,
			)
			return false
		}

		return true
	}

	return true
}
