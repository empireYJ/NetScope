import os from 'node:os';
import {createHash} from 'node:crypto';

// Keep this UTF-8 SHA-256 format in sync with scripts/identity.ps1 and DesktopIdentity.cs.
export const USER_ID=createHash('sha256').update(os.userInfo().username.toLowerCase(),'utf8').digest('hex').slice(0,16);
export const SENSOR_PIPE='NetScope-System-'+USER_ID;
