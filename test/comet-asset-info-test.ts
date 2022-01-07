import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
  FaucetToken__factory,
  FaucetToken,
  MockedOracle,
  MockedOracle__factory,
  Comet,
  Comet__factory,
} from '../build/types';

let token: FaucetToken, asset1: FaucetToken, asset2: FaucetToken, comet: Comet, governor, oracle: MockedOracle;
const FACTOR = ethers.utils.parseEther('1');

describe('Comet', function () {
  beforeEach(async () => {
    [governor] = await ethers.getSigners();

    const FaucetTokenFactory = (await ethers.getContractFactory(
      'FaucetToken'
    )) as FaucetToken__factory;
    token = await FaucetTokenFactory.deploy(100000, 'DAI', 18, 'DAI');
    await token.deployed();

    asset1 = await FaucetTokenFactory.deploy(100000, 'Asset1', 18, 'ASSET1');
    await asset1.deployed();
    asset2 = await FaucetTokenFactory.deploy(100000, 'Asset2', 18, 'ASSET2');
    await asset2.deployed();

    const OracleFactory = (await ethers.getContractFactory(
      'MockedOracle'
    )) as MockedOracle__factory;
    oracle = await OracleFactory.deploy();
    await oracle.deployed();

    const CometFactory = (await ethers.getContractFactory(
      'Comet'
    )) as Comet__factory;
    comet = await CometFactory.deploy({
      governor: governor.address,
      priceOracle: oracle.address,
      baseToken: token.address,
      assetInfo: [{ asset: asset1.address, borrowCollateralFactor: FACTOR, liquidateCollateralFactor: FACTOR }, { asset: asset2.address, borrowCollateralFactor: FACTOR, liquidateCollateralFactor: FACTOR }]
    });
    await comet.deployed();
  });

  it('Should properly initialize Comet protocol', async () => {
    const cometGovernor = await comet.governor();
    expect(cometGovernor).to.be.equal(governor.address);

    const priceOracle = await comet.priceOracle();
    expect(priceOracle).to.be.equal(oracle.address);

    const cometBaseToken = await comet.baseToken();
    expect(cometBaseToken).to.be.equal(token.address);

    const cometNumAssets = await comet.numAssets();
    const cometMaxAssets = await comet.maxAssets();
    expect(cometMaxAssets).to.be.equal(cometNumAssets);
    expect(cometNumAssets).to.be.equal(2);

    const assetInfo00 = await comet.getAssetInfo(0);
    expect(assetInfo00.asset).to.be.equal(asset1.address);
    expect(assetInfo00.borrowCollateralFactor).to.equal(FACTOR);
    expect(assetInfo00.liquidateCollateralFactor).to.equal(FACTOR);

    const assetInfo01 = await comet.getAssetInfo(1);
    expect(assetInfo01.asset).to.be.equal(asset2.address);
    expect(assetInfo01.borrowCollateralFactor).to.equal(FACTOR);
    expect(assetInfo01.liquidateCollateralFactor).to.equal(FACTOR);
  });

  it('Should revert if index is greater that numAssets', async () => {
    await expect(comet.getAssetInfo(2)).to.be.revertedWith('asset info not found');
  });
});
