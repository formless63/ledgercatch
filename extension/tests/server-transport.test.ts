import {describe,it,expect} from "vitest";
import {normalizeServerUrl} from "../src/lib/util";
describe("server transport",()=>{
 it("accepts HTTPS and explicit loopback development only",()=>{
 expect(normalizeServerUrl("https://ledger.example.test/")).toBe("https://ledger.example.test");
 for(const host of ["localhost","127.0.0.1","[::1]"])expect(normalizeServerUrl(`http://${host}:4300`)).toBeTruthy();
 for(const url of ["http://ledger.example.test", "http://192.168.1.2", "https://user:secret@ledger.example.test", "file:///tmp/x"])expect(normalizeServerUrl(url)).toBeNull();
 });
});
