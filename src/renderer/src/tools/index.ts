// Importing a tool module runs its register() calls as a side effect.
// This file is the single place that pulls them all in.
import './text/base64'
import './text/dedup'
import './text/caseConvert'
import './text/whitespace'
import './text/urlEncode'
import './text/hex'
import './ioc/extract'
import './ioc/defang'
import './query/crowdstrike'
