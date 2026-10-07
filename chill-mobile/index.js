import 'react-native-get-random-values';
/**
 * @format
 * 第一行必须是 react-native-get-random-values：Hermes 无安全随机源，
 * 漏了这步 tweetnacl keygen 用弱随机或直接抛错（RN 最经典事故）。
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
