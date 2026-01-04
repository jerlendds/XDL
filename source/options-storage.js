import OptionsSync from 'webext-options-sync';

const optionsStorage = new OptionsSync({
	defaults: {
		imageFolder: '',
		videoFolder: '',
	},
	migrations: [
		OptionsSync.migrations.removeUnused,
	],
	logging: true,
});

export default optionsStorage;
