import test from "node:test";
import assert from "node:assert/strict";
import { matchesInstanceSearch } from "../shared/instance-search.ts";

const instances = [
  { name: "Backup", id: "i-backup", region: "cn-hongkong", ip: ["192.0.2.19"] },
  { name: "Web", id: "i-web", region: "cn-hongkong", ip: ["192.0.2.18"] },
  { name: "API", id: "i-api", region: "ap-southeast-1", ip: ["2001:db8::20"] },
  { name: "Worker", id: "i-worker", region: "cn-hangzhou", ip: [] },
];
const search = (query) =>
  instances.filter((i) => matchesInstanceSearch(i, query)).map((i) => i.id);

test("实例搜索匹配显示的中文地域，同时保留英文地域代码、名称和 IP 搜索", () => {
  for (const query of ["香港", "中国香港", "HongKong", "cn-hongkong", " 香港 "])
    assert.deepEqual(search(query), ["i-backup", "i-web"]);
  assert.deepEqual(search("新加坡"), ["i-api"]);
  assert.deepEqual(search("杭州"), ["i-worker"]);
  assert.deepEqual(search("华东 1"), ["i-worker"]);
  assert.deepEqual(search("BACKUP"), ["i-backup"]);
  assert.deepEqual(search("i-web"), ["i-web"]);
  assert.deepEqual(search("192.0.2.19"), ["i-backup"]);
  assert.deepEqual(search("2001:DB8"), ["i-api"]);
  assert.deepEqual(
    search(""),
    instances.map((i) => i.id),
  );
  assert.deepEqual(
    search("   "),
    instances.map((i) => i.id),
  );
  assert.deepEqual(search("不存在"), []);
});

test("未知地域仍可按原始代码搜索，中文地域搜索不会匹配无关实例", () => {
  const unknown = {
    name: "Future",
    id: "i-future",
    region: "new-region-1",
    ip: [],
  };
  assert.equal(matchesInstanceSearch(unknown, "NEW-REGION"), true);
  assert.equal(matchesInstanceSearch(unknown, "香港"), false);
  assert.equal(matchesInstanceSearch(instances[2], "香港"), false);
});
