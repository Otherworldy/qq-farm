const test = require('node:test');
const assert = require('node:assert/strict');

// 黄金变异果实（104 段）识别回归。
// 背景：背包出现 1041435×4、1042254×2，本地物品索引都没有条目，
// warehouse 每轮打 "bag contains items missing from local item index"。
// 规律已由 14 条已登记条目验证：1040000+X ↔ 植物 1020000+X。
// 1041435 有官方 Plant 行（森野柿子）所以逐条登记；
// 1042254 的植物 1022254 在所有配置里都不存在，只能按 ID 结构推导出占位名，
// 不允许猜中文名。

const { getItemById, getPlantById, getAllPlants, loadConfigs } = require('../src/config/gameConfig');

loadConfigs();

test('1041435 登记为黄金·森野柿子，且植物有官方行', () => {
  const item = getItemById(1041435);
  assert.ok(item, '1041435 应有物品条目');
  assert.equal(item.name, '黄金·森野柿子');
  assert.equal(item.type, 17);
  assert.equal(item.asset_name, 'gold/Crop_1435');
  assert.equal(item.sells, '1005:6');
  assert.ok(!item.derived, '正式登记条目不应标记为推导');

  // 名称必须来自真实植物行，不能是编造的。
  const plant = getPlantById(1021435);
  assert.ok(plant, '1021435 森野柿子 应存在于植物配置');
  assert.equal(plant.name, '森野柿子');
  assert.equal(plant.fruit.id, 41435);
});

test('1042254 的植物缺失时只给占位名，不编造中文名', () => {
  const item = getItemById(1042254);
  assert.ok(item, '1042254 应能识别为黄金果实');
  assert.equal(item.type, 17);
  assert.equal(item.asset_name, 'gold/Crop_2254');
  assert.equal(item.derived, true);
  assert.equal(item.name, '黄金果实2254');
  assert.ok(!getPlantById(1022254), '1022254 不应被凭空造出来');
});

test('推导规则覆盖整个 104 段且不越界', () => {
  // 104 段全部可识别，说明不会再触发 bag_unclassified_item。
  for (const offset of [1, 21, 435, 1435, 2254, 5995, 9005, 9999]) {
    const item = getItemById(1040000 + offset);
    assert.ok(item, `104${offset} 应可识别`);
    assert.equal(item.type, 17);
    assert.equal(item.asset_name, `gold/Crop_${offset}`);
  }
  // 段外不误判。
  assert.equal(getItemById(1039999), undefined);
  assert.equal(getItemById(1050000), undefined);
  assert.equal(getItemById(1040000), undefined);
});

test('已登记的黄金果实不被推导规则覆盖', () => {
  const item = getItemById(1040516);
  assert.equal(item.name, '黄金·狗尾草');
  assert.ok(!item.derived, '已有官方条目优先于推导');
});

test('104 段之外的非果实条目不受影响', () => {
  assert.equal(getItemById(1041).name, '奶茶券');
  assert.equal(getItemById(1042).name, '宣传喇叭');
});

test('推导名称随植物表加载就绪而更新', () => {
  // 植物的名字来源可能晚于首次查询；同 id 反复查询必须稳定。
  const first = getItemById(1041435);
  const second = getItemById(1041435);
  assert.equal(first.name, second.name);
  const all = getAllPlants();
  assert.ok(Array.isArray(all) && all.length > 0);
});
