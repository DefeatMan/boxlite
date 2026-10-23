// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package dto

import (
	"encoding/json"
	"testing"
)

// The API sends readOnly on a volume the caller asked to mount read-only. A
// VolumeDTO that dropped the key would hand the box a writable mount the caller
// believes is protected, so the round trip must keep it.
func TestVolumeDTOKeepsReadOnly(t *testing.T) {
	var volume VolumeDTO
	if err := json.Unmarshal([]byte(`{"volumeId":"vol-1","mountPath":"/data","readOnly":true}`), &volume); err != nil {
		t.Fatalf("decode: %v", err)
	}

	encoded, err := json.Marshal(volume)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatalf("decode fields: %v", err)
	}
	if fields["readOnly"] != true {
		t.Fatalf("readOnly lost on the way through VolumeDTO: %s", encoded)
	}
}

// An older API never sends readOnly; that must stay a read-write mount.
func TestVolumeDTOOmitsReadOnlyWhenUnset(t *testing.T) {
	var volume VolumeDTO
	if err := json.Unmarshal([]byte(`{"volumeId":"vol-1","mountPath":"/data"}`), &volume); err != nil {
		t.Fatalf("decode: %v", err)
	}

	encoded, err := json.Marshal(volume)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatalf("decode fields: %v", err)
	}
	if _, present := fields["readOnly"]; present {
		t.Fatalf("an unset readOnly must not appear on the wire: %s", encoded)
	}
}
