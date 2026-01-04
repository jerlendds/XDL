import OptionsSync from 'webext-options-sync';
import { DEFAULT_OPTIONS } from './allowed-hosts.js';

const optionsStorage = new OptionsSync({
	defaults: DEFAULT_OPTIONS,
	migrations: [
		OptionsSync.migrations.removeUnused,
	],
	logging: true,
});

export default optionsStorage;
