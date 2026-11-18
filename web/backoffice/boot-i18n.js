// Imported before anything else: the language of the console is set before a module reads a text.
import { preferredLanguage, setLanguage } from '../shared/i18n.jsx';
import shared from '../shared/fr.json';
import own from './fr.json';

setLanguage(preferredLanguage(), { ...shared, ...own });
