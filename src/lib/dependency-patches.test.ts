import { expect, it } from "vitest";
import { verifyDependencyPatches } from "../../scripts/verify-dependency-patches";

it("verifies patched package artifacts, hostile target/source shapes, nested placeholders and normal merges", () => {
	expect(verifyDependencyPatches).not.toThrow();
});
