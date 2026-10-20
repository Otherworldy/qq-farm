const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/gameConfig');

// 证据链：ItemInfo 20165=茱萸种子 / 40165=茱萸（同为 Crop_165、price 8244/103、
// level 101、rarity 2，与铃兰 20108/40108 完全同档），官方 gamecaches 存在
// model/v4/Crop_165_2..6 普通阶段资源且无 Spine，因此按单格作物登记。
test('茱萸 seed 20165 maps to a single-plot plant with its fruit', () => {
  const plant = config.getPlantBySeedId(20165);
  assert.ok(plant, '茱萸种子必须有 Plant 映射');
  assert.equal(plant.id, 1020165);
  assert.equal(plant.name, '茱萸');
  assert.equal(plant.size, 1);
  assert.equal(plant.land_level_need, 1);
  assert.equal(plant.asset_name, 'Crop_165');
  assert.deepEqual(plant.fruit, { id: 40165, count: 48 });
  assert.equal(config.getPlantByFruitId(40165)?.id, 1020165);
});
