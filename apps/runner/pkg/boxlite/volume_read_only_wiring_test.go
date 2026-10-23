// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// TestCreateBindsReadOnlyVolumesReadOnly guards the hops a behavioral test
// cannot see: boxlite.BoxOption closes over an unexported config, so a fake
// runtime receives opaque functions and cannot tell WithBindMount from
// WithBindMountReadOnly, and getVolumeMounts needs a FUSE mount to run. If
// either hop drops the flag, a read-only managed volume binds read-write. Same
// AST technique as TestCreateAppliesSecrets.
func TestCreateBindsReadOnlyVolumesReadOnly(t *testing.T) {
	fileSet := token.NewFileSet()

	client, err := parser.ParseFile(fileSet, "client.go", nil, 0)
	if err != nil {
		t.Fatalf("parse client.go: %v", err)
	}
	create := findMethod(client, "Client", "Create")
	if create == nil {
		t.Fatal("Client.Create not found in client.go")
	}
	// The read-only bind must be chosen by the mount's flag, not
	// unconditionally: `if <mount>.readOnly { WithBindMountReadOnly(...) }`.
	guarded := false
	ast.Inspect(create.Body, func(node ast.Node) bool {
		ifStmt, ok := node.(*ast.IfStmt)
		if !ok {
			return true
		}
		selector, ok := ifStmt.Cond.(*ast.SelectorExpr)
		if ok && selector.Sel.Name == "readOnly" && findCall(ifStmt.Body, "boxlite", "WithBindMountReadOnly") != nil {
			guarded = true
		}
		return true
	})
	if !guarded {
		t.Fatal("Client.Create does not pick boxlite.WithBindMountReadOnly under an `if <mount>.readOnly` branch")
	}

	volumes, err := parser.ParseFile(fileSet, "volumes.go", nil, 0)
	if err != nil {
		t.Fatalf("parse volumes.go: %v", err)
	}
	getMounts := findMethod(volumes, "Client", "getVolumeMounts")
	if getMounts == nil {
		t.Fatal("Client.getVolumeMounts not found in volumes.go")
	}
	// Each volumeMount it builds must take readOnly from the DTO.
	carried := false
	ast.Inspect(getMounts.Body, func(node ast.Node) bool {
		pair, ok := node.(*ast.KeyValueExpr)
		if !ok {
			return true
		}
		key, keyOk := pair.Key.(*ast.Ident)
		value, valueOk := pair.Value.(*ast.SelectorExpr)
		if keyOk && valueOk && key.Name == "readOnly" && value.Sel.Name == "ReadOnly" {
			carried = true
		}
		return true
	})
	if !carried {
		t.Fatal("Client.getVolumeMounts does not set volumeMount.readOnly from VolumeDTO.ReadOnly")
	}
}
