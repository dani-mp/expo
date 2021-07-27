import spawnAsync from '@expo/spawn-async';
import { IosPlist } from '@expo/xdl';
import fs from 'fs';
import inquirer from 'inquirer';
import path from 'path';

import { runExpoCliAsync } from '../ExpoCLI';
import Logger from '../Logger';

type Action = {
  platform: 'android' | 'ios' | 'web';
  packageName: string;
};

async function action(packageName: string, { platform }: Action) {
  const cwdPkg = require(path.resolve(process.cwd(), 'package.json'));
  const cwdPkgName = cwdPkg.name;

  let buildStoryLoader = true;

  if (cwdPkgName && cwdPkgName !== '@expo/expo') {
    packageName = cwdPkgName;
  }

  if (!packageName) {
    const { pkg } = await inquirer.prompt({
      type: 'input',
      name: 'pkg',
      message: 'Which package are you working on?',
    });

    packageName = pkg;
  }

  // eslint-disable-next-line
  const packageRoot = path.resolve(__dirname, '../../../packages', packageName);
  if (!fs.existsSync(packageRoot)) {
    throw new Error(
      `${packageName} does not exist - are you sure you selected the correct package?`
    );
  }

  // eslint-disable-next-line
  const examplesRoot = path.resolve(__dirname, '../../../story-loaders');

  if (!fs.existsSync(examplesRoot)) {
    fs.mkdirSync(examplesRoot);
  }

  const projectName = `${packageName}-stories`;
  const targetName = projectName.split('-').join('');

  const projectRoot = path.resolve(examplesRoot, projectName);

  if (fs.existsSync(projectRoot)) {
    const { shouldRebuild } = await inquirer.prompt({
      type: 'confirm',
      name: 'shouldRebuild',
      message: 'This project has already been built - do you want to rebuild it from scratch?',
      default: false,
    });

    if (!shouldRebuild) {
      Logger.log();
      Logger.info(`Project found at ${projectRoot}`);
      Logger.log();
    }

    buildStoryLoader = shouldRebuild;
  }

  if (buildStoryLoader) {
    if (fs.existsSync(projectRoot)) {
      // @ts-ignore
      fs.rmdirSync(projectRoot, { recursive: true, force: true });
    }

    Logger.log();
    Logger.info(`🛠  Building fresh story loader for ${packageName}`);
    Logger.log();

    // 1. initialize expo project w/ name
    await runExpoCliAsync('init', [projectName, '-t', 'bare-minimum', '--no-install'], {
      cwd: examplesRoot,
      stdio: 'ignore',
    });

    // remove .git repo for newly built project
    // @ts-ignore
    fs.rmdirSync(path.resolve(projectRoot, '.git'), { force: true, recursive: true });

    // 2. run expo prebuild on project
    // First update bundle ids
    const appJsonPath = path.resolve(projectRoot, 'app.json');
    const appJson = require(appJsonPath);
    const bundleId = `com.expostories.${targetName}`;

    appJson.expo.android = {
      package: bundleId,
    };

    appJson.expo.ios = {
      bundleIdentifier: bundleId,
    };

    fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, '\t'), { encoding: 'utf-8' });

    await runExpoCliAsync('prebuild', ['--no-install'], { cwd: projectRoot, stdio: 'ignore' });
  }

  // 3. copy over template files for project
  // eslint-disable-next-line
  const templateRoot = path.resolve(__dirname, '../../../template-files/stories-templates');

  // metro config
  const metroConfigPath = path.resolve(templateRoot, 'metro.config.js');
  fs.copyFileSync(metroConfigPath, path.resolve(projectRoot, 'metro.config.js'));

  // package.json
  const defaultPkg = require(path.resolve(templateRoot, 'pkg.json'));
  const projectPkg = require(path.resolve(projectRoot, 'package.json'));
  const packagePkg = require(path.resolve(packageRoot, 'package.json'));

  const mergedPkg = {
    ...projectPkg,
    ...defaultPkg,
  };

  // configure story server
  mergedPkg.expoStories = {
    projectRoot,
    watchRoot: packageRoot,
  };

  // remove dependencies from excluded autolinked packages
  const defaultPackagesToExclude = mergedPkg.expo.autolinking.exclude;
  const extraNodeModules: any = packagePkg.expoStories?.packages ?? {};

  const packagesRequiredByModule: string[] = [
    ...Object.keys(extraNodeModules),
    ...Object.keys(mergedPkg?.dependencies ?? {}),
  ];

  const packagesToExclude = defaultPackagesToExclude.filter(
    (pkg: string) => !packagesRequiredByModule.includes(pkg)
  );

  mergedPkg.expo.autolinking.exclude = packagesToExclude;

  mergedPkg.dependencies = {
    ...mergedPkg.dependencies,
    ...extraNodeModules,
  };

  fs.writeFileSync(
    path.resolve(projectRoot, 'package.json'),
    JSON.stringify(mergedPkg, null, '\t')
  );

  // AppDelegate.{h,m}
  const iosRoot = path.resolve(projectRoot, 'ios', targetName);

  fs.copyFileSync(
    path.resolve(templateRoot, 'ios/AppDelegate.h'),
    path.resolve(iosRoot, 'AppDelegate.h')
  );

  fs.copyFileSync(
    path.resolve(templateRoot, 'ios/AppDelegate.m'),
    path.resolve(iosRoot, 'AppDelegate.m')
  );

  // Podfile
  const podfileRoot = path.resolve(projectRoot, 'ios/Podfile');

  fs.copyFileSync(path.resolve(templateRoot, 'ios/Podfile'), podfileRoot);

  // update target
  let podFileStr = fs.readFileSync(podfileRoot, { encoding: 'utf-8' });
  podFileStr = podFileStr.replace('{{ targetName }}', targetName);

  fs.writeFileSync(path.resolve(projectRoot, 'ios/Podfile'), podFileStr, { encoding: 'utf-8' });

  // Info.plist -> add splash screen
  IosPlist.modifyAsync(iosRoot, 'Info', (config) => {
    config['UILaunchStoryboardName'] = 'SplashScreen';
    return config;
  });

  // .watchmanconfig
  fs.writeFileSync(path.resolve(projectRoot, '.watchmanconfig'), '{}', { encoding: 'utf-8' });
  fs.copyFileSync(path.resolve(templateRoot, 'App.js'), path.resolve(projectRoot, 'App.js'));

  // 4. yarn + install deps
  Logger.log('🧶 Yarning...');
  Logger.log();
  await spawnAsync('yarn', ['install'], { cwd: projectRoot });

  Logger.log('✅ Done!');
  Logger.log();

  if (!platform) {
    const { selectedPlatform } = await inquirer.prompt({
      type: 'list',
      name: 'selectedPlatform',
      message: 'Which platform are you working on?',
      choices: [
        { value: 'ios', name: 'iOS' },
        { value: 'android', name: 'Android' },
        { value: 'web', name: 'Web' },
      ],
    });

    platform = selectedPlatform;
  }

  Logger.log();

  if (platform === 'web') {
  } else {
    const command = `run:${platform}`;
    Logger.log(`🛠  Building for ${platform}...this may take a few minutes`);
    Logger.log();
    runExpoCliAsync(command, [], { cwd: projectRoot });
  }

  spawnAsync('yarn', ['stories'], { cwd: projectRoot }).catch(() => {});
}

export default (program: any) => {
  program
    .command('run-stories <packageName>')
    .option('-p, --platform <string>', 'Which platform we should run the app on')
    .asyncAction(action);
};
