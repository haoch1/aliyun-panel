export interface RegionOption {
  regionId: string;
  localName: string;
}
// Initial ECS choices; authenticated DescribeRegions supplies the current list.
export const commonRegions: RegionOption[] = [
  ["cn-hongkong", "中国香港"],
  ["cn-hangzhou", "华东 1（杭州）"],
  ["cn-shanghai", "华东 2（上海）"],
  ["cn-qingdao", "华北 1（青岛）"],
  ["cn-beijing", "华北 2（北京）"],
  ["cn-zhangjiakou", "华北 3（张家口）"],
  ["cn-huhehaote", "华北 5（呼和浩特）"],
  ["cn-wulanchabu", "华北 6（乌兰察布）"],
  ["cn-shenzhen", "华南 1（深圳）"],
  ["cn-heyuan", "华南 2（河源）"],
  ["cn-guangzhou", "华南 3（广州）"],
  ["cn-chengdu", "西南 1（成都）"],
  ["cn-wuhan-lr", "华中 1（武汉）"],
  ["cn-nanjing", "华东 5（南京）"],
  ["cn-fuzhou", "华东 6（福州）"],
  ["ap-southeast-1", "新加坡"],
  ["ap-southeast-3", "马来西亚（吉隆坡）"],
  ["ap-southeast-5", "印度尼西亚（雅加达）"],
  ["ap-southeast-6", "菲律宾（马尼拉）"],
  ["ap-southeast-7", "泰国（曼谷）"],
  ["ap-northeast-1", "日本（东京）"],
  ["ap-northeast-2", "韩国（首尔）"],
  ["eu-west-1", "英国（伦敦）"],
  ["eu-central-1", "德国（法兰克福）"],
  ["us-east-1", "美国（弗吉尼亚）"],
  ["us-west-1", "美国（硅谷）"],
  ["me-central-1", "沙特（利雅得）"],
  ["me-east-1", "阿联酋（迪拜）"],
  ["ap-south-1", "印度（孟买）"],
].map(([regionId, localName]) => ({ regionId, localName }));
export const regionName = (id: string) =>
  commonRegions.find((r) => r.regionId === id)?.localName || id;
