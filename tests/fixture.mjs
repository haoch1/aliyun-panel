import { Store } from "../server/store.mjs";
import { AliyunGateway } from "../server/aliyun.mjs";
import { ResourceService } from "../server/service.mjs";
import { Jobs } from "../server/jobs.mjs";
import { Engine } from "../server/engine.mjs";
import { Notifications } from "../server/notify.mjs";
export function fixture(dir) {
  const store = new Store(dir),
    calls = [],
    state = new Map([
      ["i-web", "Running"],
      ["i-data", "Stopped"],
      ["i-edge", "Running"],
    ]);
  const extraRows = [];
  const rpc = async (a, region, action, params, options) => {
    calls.push({ region, action, params, options });
    if (action === "GetCallerIdentity")
      return { accountId: "fixture-owner", principalId: "fixture-ram" };
    if (action === "DescribeRegions")
      return {
        regions: {
          region: [
            { regionId: "cn-hongkong", localName: "中国香港" },
            { regionId: "cn-hangzhou", localName: "华东 1（杭州）" },
          ],
        },
      };
    if (action === "ListPlans")
      return {
        plans: [
          {
            planId: "plan-200",
            core: 2,
            memory: 2,
            diskSize: 40,
            flow: 200,
            originPrice: "24",
            currency: "CNY",
          },
        ],
      };
    const rows = [
      {
        instanceId: "i-web",
        instanceName: "香港 Web",
        regionId: "cn-hongkong",
        publicIpAddress: { ipAddress: ["203.0.113.10"] },
      },
      {
        instanceId: "i-data",
        instanceName: "数据服务",
        regionId: "cn-hongkong",
        publicIpAddress: { ipAddress: ["203.0.113.11"] },
      },
      {
        instanceId: "i-edge",
        instanceName: "杭州应用",
        regionId: "cn-hangzhou",
        publicIpAddress: { ipAddress: ["198.51.100.23"] },
      },
    ].concat(extraRows);
    if (action === "DescribeInstances") {
      const ids = params.instanceIds ? JSON.parse(params.instanceIds) : null;
      const items = rows
        .filter(
          (r) => r.regionId === region && (!ids || ids.includes(r.instanceId)),
        )
        .map((r) => ({
          ...r,
          status: state.get(r.instanceId),
          planId: "plan-200",
          resourceSpec: { cpu: 2, memory: 2, diskSize: 40, flow: 200 },
          expiredTime: new Date(Date.now() + 180 * 86400000).toISOString(),
          creationTime: "2026-09-01T00:00:00Z",
        }));
      return { instances: { instance: items }, totalCount: items.length };
    }
    if (action === "ListInstanceStatus") {
      const ids = JSON.parse(params.instanceIds);
      return {
        instanceStatuses: ids.map((id) => ({
          instanceId: id,
          status: state.get(id) || "Unknown",
        })),
        totalCount: ids.length,
      };
    }
    if (action === "ListCdtInternetTraffic")
      return {
        trafficDetails: [
          { businessRegionId: "cn-hongkong", traffic: 96 * 1024 ** 3 },
          { businessRegionId: "cn-hangzhou", traffic: 4.2 * 1024 ** 3 },
        ],
      };
    if (action === "StartInstance") {
      state.set(params.instanceId, "Running");
      return { requestId: "fixture-start" };
    }
    if (action === "StopInstance") {
      state.set(params.instanceId, "Stopped");
      return { requestId: "fixture-stop" };
    }
    if (action === "DescribeInstanceMonitorData") {
      for (const field of ["startTime", "endTime"])
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(params[field]))
          throw new Error("InvalidTime.Malformed: UTC seconds are required");
      const end = Date.parse(params.endTime),
        start = Date.parse(params.startTime);
      if ((end - start) / (params.period * 1000) > 400)
        throw new Error("InvalidParameter: at most 400 monitor points");
      return {
        monitorData: {
          instanceMonitorData: Array.from(
            { length: Math.floor((end - start) / 3600000) },
            (_, i) => ({
              timeStamp: new Date(end - i * 3600000).toISOString(),
              internetTX: 40 + (i % 10),
              internetRX: 20 + (i % 10),
            }),
          ),
        },
      };
    }
    if (action === "DescribeEipMonitorData") {
      if (options.product !== "vpc" || !params.allocationId || !params.regionId)
        throw new Error("Invalid EIP monitor target");
      for (const field of ["startTime", "endTime"])
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(params[field]))
          throw new Error("InvalidTime.Malformed: UTC seconds are required");
      const end = Date.parse(params.endTime),
        start = Date.parse(params.startTime);
      if ((end - start) / (params.period * 1000) > 200)
        throw new Error("Too many EIP monitor points");
      return {
        eipMonitorDatas: {
          eipMonitorData: Array.from(
            { length: Math.floor((end - start) / 3600000) },
            (_, i) => ({
              timeStamp: new Date(end - i * 3600000).toISOString(),
              eipTX: 8192,
              eipRX: 4096,
            }),
          ),
        },
      };
    }
    if (action === "QueryAccountBalance")
      return { data: { availableAmount: "100.00", currency: "CNY" } };
    if (action === "DescribeInstanceBill")
      return {
        success: true,
        code: "Success",
        data: {
          items: [{ instanceID: "i-web", pretaxAmount: 24, currency: "CNY" }],
        },
      };
    throw new Error("Fixture 未提供接口 " + action);
  };
  const gateway = new AliyunGateway(store, { rpc }),
    service = new ResourceService(store, gateway),
    notify = new Notifications(store, { send: async () => {} }),
    jobs = new Jobs(store, gateway, service, notify),
    engine = new Engine(store, gateway, service, jobs, notify);
  const a = store.saveAccount(
    {
      name: "开发账号",
      cloudAccountId: "fixture-owner",
      principalId: "fixture-ram",
      site: "china",
      region: "cn-hongkong",
      keyTail: "test",
    },
    { accessKeyId: "fixture-key", accessKeySecret: "fixture-secret" },
    "account-test",
  );
  // These regression fixtures begin with explicit per-instance keepalive off.
  for (const [id, region] of [
    ["i-web", "cn-hongkong"],
    ["i-data", "cn-hongkong"],
    ["i-edge", "cn-hangzhou"],
  ])
    store.saveRule({ accountId: a.id, region, id }, { keepAlive: false });
  return {
    store,
    gateway,
    service,
    notify,
    jobs,
    engine,
    calls,
    state,
    extraRows,
    account: a,
  };
}
