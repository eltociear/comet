import { StaticConstraint, Solution, World, debug } from '../../plugins/scenario';
import { CometContext } from '../context/CometContext';
import { Migration, loadMigrations, Actions } from '../../plugins/deployment_manager/Migration';
import { modifiedPaths, subsets } from '../utils';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { impersonateAddress } from '../../plugins/scenario/utils';
import { exp } from '../../test/helpers';

async function getMigrations<T>(world: World): Promise<Migration<T>[]> {
  // TODO: make this configurable from cli params/env var?
  const network = world.deploymentManager.network;
  const deployment = world.deploymentManager.deployment;
  const pattern = new RegExp(`deployments/${network}/${deployment}/migrations/.*.ts`);
  return await loadMigrations((await modifiedPaths(pattern)).map(p => '../../' + p));
}

async function isEnacted<T>(actions: Actions<T>, dm: DeploymentManager, govDm: DeploymentManager): Promise<boolean> {
  return actions.enacted ? await actions.enacted(dm, govDm) : false;
}

export class MigrationConstraint<T extends CometContext> implements StaticConstraint<T> {
  async solve(world: World) {
    const label = `[${world.base.name}] {MigrationConstraint}`;
    const solutions: Solution<T>[] = [];
    const migrationPaths = [...subsets(await getMigrations(world))];

    for (const migrationList of migrationPaths) {
      if (migrationList.length == 0 && migrationPaths.length > 1) {
        if (!process.env['WITHOUT_MIGRATIONS']) {
          debug(`${label} Skipping empty migration`);
          continue;
        }
      }
      solutions.push(async function (ctx: T): Promise<T> {
        const govDeploymentManager = ctx.world.auxiliaryDeploymentManager || ctx.world.deploymentManager;
        const compWhale = (await ctx.getCompWhales())[0];
        const proposer = await impersonateAddress(govDeploymentManager, compWhale, exp(1, 18)); // give them enough ETH to make the proposal

        // Make proposer the default signer
        govDeploymentManager._signers.unshift(proposer);

        // Order migrations deterministically and store in the context (i.e. for verification)
        migrationList.sort((a, b) => a.name.localeCompare(b.name));
        ctx.migrations = migrationList;

        debug(`${label} Running scenario with migrations: ${JSON.stringify(migrationList.map((m) => m.name))}`);
        for (const migration of migrationList) {
          const artifact = await migration.actions.prepare(ctx.world.deploymentManager, govDeploymentManager);
          debug(`${label} Prepared migration ${migration.name}.\n  Artifact\n-------\n\n${JSON.stringify(artifact, null, 2)}\n-------\n`);
          if (await isEnacted(migration.actions, ctx.world.deploymentManager, govDeploymentManager)) {
            debug(`${label} Migration ${migration.name} has already been enacted`);
          } else {
            await migration.actions.enact(ctx.world.deploymentManager, govDeploymentManager, artifact);
            debug(`${label} Enacted migration ${migration.name}`);
          }
        }

        // Remove proposer from signers
        govDeploymentManager._signers.shift();

        return ctx;
      });
    }

    return solutions;
  }

  async check() {
    return; // XXX
  }
}

export class VerifyMigrationConstraint<T extends CometContext> implements StaticConstraint<T> {
  async solve(world: World) {
    const label = `[${world.base.name}] {VerifyMigrationConstraint}`;
    return [
      async function (ctx: T): Promise<T> {
        const govDeploymentManager = ctx.world.auxiliaryDeploymentManager || ctx.world.deploymentManager;
        if (ctx.migrations) {
          for (const migration of ctx.migrations) {
            if (migration.actions.verify && !(await isEnacted(migration.actions, ctx.world.deploymentManager, govDeploymentManager))) {
              await migration.actions.verify(ctx.world.deploymentManager, govDeploymentManager);
              debug(`${label} Verified migration "${migration.name}"`);
            }
          }
        }
        return ctx;
      }
    ];
  }

  async check() {
    return; // XXX
  }
}
