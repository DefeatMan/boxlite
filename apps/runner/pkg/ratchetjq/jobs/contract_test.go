/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package jobs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// contractPath is the checked-in list both halves of a job type are checked
// against (apps/libs/ratchetjq-contract/README.md). Reaching outside this module
// is the point: the file is shared with the control plane, which is the side this
// test exists to stay in step with.
const contractPath = "../../../../libs/ratchetjq-contract/job-types.json"

// TestJobTypesMatchTheContract is the runner half of the cross-language check.
//
// The control plane registers its acceptors independently, keyed by the same
// strings, and nothing at build time compares the two lists — a name present here
// and missing there costs a job every round it has and retires it as a timeout.
// So each side checks itself against one checked-in list, and drift fails CI on
// whichever side drifted.
//
// Both directions are asserted, because the two failures are different mistakes:
// a type registered here and not listed is one the control plane was never told
// about, and a type listed but not registered here is one no runner can run.
func TestJobTypesMatchTheContract(t *testing.T) {
	registered := make([]string, 0, len(JobTypes()))
	for _, prototype := range JobTypes() {
		registered = append(registered, prototype.Type())
	}
	sort.Strings(registered)

	declared := readContract(t)
	sort.Strings(declared)

	if len(registered) != len(declared) {
		t.Fatalf("this runner registers %v, the contract declares %v", registered, declared)
	}
	for index := range declared {
		if registered[index] != declared[index] {
			t.Errorf("this runner registers %v, the contract declares %v", registered, declared)
			break
		}
	}
}

// readContract reads the declared job type names, failing the test rather than
// skipping when the file cannot be read: a contract test that quietly passes
// because it found nothing to compare against is worse than no test.
func readContract(t *testing.T) []string {
	t.Helper()

	raw, err := os.ReadFile(filepath.Clean(contractPath))
	if err != nil {
		t.Fatalf("reading the job type contract at %s: %v", contractPath, err)
	}

	var contract struct {
		JobTypes []string `json:"jobTypes"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("decoding the job type contract at %s: %v", contractPath, err)
	}
	if len(contract.JobTypes) == 0 {
		t.Fatalf("the job type contract at %s declares no job types", contractPath)
	}

	return contract.JobTypes
}
