import { Signer, Contract } from 'ethers';
import { ForkSpec, World, buildScenarioFn } from '../../plugins/scenario';
import { ContractMap, DeploymentManager } from '../../plugins/deployment_manager/DeploymentManager';
import { BalanceConstraint, RemoteTokenConstraint } from '../constraints';
import CometActor from './CometActor';
import CometAsset from './CometAsset';
import { Comet, deployComet } from '../../src/deploy';
import { Token } from '../../build/types';

export class CometContext {
  deploymentManager: DeploymentManager;
  actors: { [name: string]: CometActor };
  assets: { [name: string]: CometAsset };
  remoteToken: Contract | undefined;
  comet: Comet;

  constructor(
    deploymentManager: DeploymentManager,
    comet: Comet,
    actors: { [name: string]: CometActor },
    assets: { [name: string]: CometAsset },
  ) {
    this.deploymentManager = deploymentManager;
    this.comet = comet;
    this.actors = actors;
    this.assets = assets;
  }

  contracts(): ContractMap {
    return this.deploymentManager.contracts;
  }
}

async function buildActor(signer: Signer, cometContract: Comet) {
  return new CometActor(signer, await signer.getAddress(), cometContract);
}

const getInitialContext = async (world: World): Promise<CometContext> => {
  let deploymentManager = new DeploymentManager(world.base.name, world.hre);

  function getContract<T extends Contract>(name: string): T {
    let contract: T = deploymentManager.contracts[name] as T;
    if (!contract) {
      throw new Error(`No such contract ${name} for base ${world.base.name}`);
    }
    return contract;
  }

  if (world.isDevelopment()) {
    await deployComet(deploymentManager, false);
  }

  await deploymentManager.spider();

  let comet = getContract<Comet>('comet');
  let signers = await world.hre.ethers.getSigners();

  const [localAdminSigner, albertSigner, bettySigner, charlesSigner] = signers;
  let adminSigner;

  if (world.isDevelopment()) {
    adminSigner = localAdminSigner;
  } else {
    const governorAddress = await comet.governor();
    adminSigner = await world.impersonateAddress(governorAddress);
  }

  const actors = {
    admin: await buildActor(adminSigner, comet),
    albert: await buildActor(albertSigner, comet),
    betty: await buildActor(bettySigner, comet),
    charles: await buildActor(charlesSigner, comet),
  };

  const assets = {
    GOLD: new CometAsset(getContract<Token>('GOLD')),
    SILVER: new CometAsset(getContract<Token>('SILVER')),
  };

  return new CometContext(deploymentManager, comet, actors, assets);
};

async function forkContext(c: CometContext): Promise<CometContext> {
  return c;
}

export const constraints = [new BalanceConstraint(), new RemoteTokenConstraint()];

export const scenario = buildScenarioFn<CometContext>(getInitialContext, forkContext, constraints);
