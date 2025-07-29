import { describe, expect, it } from 'vitest'

//

import nmtjs from 'nmtjs'

//

import * as application from 'nmtjs/application'
import * as cli from 'nmtjs/cli'
import * as common from 'nmtjs/common'
import contractDefault, * as contract from 'nmtjs/contract'
import * as core from 'nmtjs/core'
import * as jsonFormat from 'nmtjs/json-format'
import * as protocol from 'nmtjs/protocol'
import * as protocolClient from 'nmtjs/protocol/client'
import * as protocolServer from 'nmtjs/protocol/server'
import * as server from 'nmtjs/server'
import typeDefault, * as type from 'nmtjs/type'
import * as wsTransport from 'nmtjs/ws-transport'

//

import * as _application from '@nmtjs/application'
import * as _cli from '@nmtjs/cli'
import * as _common from '@nmtjs/common'
import _contractDefault, * as _contract from '@nmtjs/contract'
import * as _core from '@nmtjs/core'
import * as _jsonFormat from '@nmtjs/json-format/server'
import * as _protocol from '@nmtjs/protocol'
import * as _protocolClient from '@nmtjs/protocol/client'
import * as _protocolServer from '@nmtjs/protocol/server'
import * as _server from '@nmtjs/server'
import _typeDefault, * as _type from '@nmtjs/type'
import * as _wsTransport from '@nmtjs/ws-transport'

describe('nmtjs', () => {
  it('should re-export packages', () => {
    expect(nmtjs).toBeDefined()
    expect(common).toBeDefined()
    expect(type).toBeDefined()
    expect(typeDefault).toBeDefined()
    expect(contract).toBeDefined()
    expect(contractDefault).toBeDefined()
    expect(core).toBeDefined()
    expect(protocol).toBeDefined()
    expect(protocolServer).toBeDefined()
    expect(protocolClient).toBeDefined()
    expect(application).toBeDefined()
    expect(server).toBeDefined()
    expect(wsTransport).toBeDefined()
    expect(jsonFormat).toBeDefined()
    expect(cli).toBeDefined()

    expect(_application).toStrictEqual(application)
    expect(_cli).toStrictEqual(cli)
    expect(_common).toStrictEqual(common)
    expect(_contractDefault).toStrictEqual(contractDefault)
    expect(_contract).toStrictEqual(contract)
    expect(_core).toStrictEqual(core)
    expect(_jsonFormat).toStrictEqual(jsonFormat)
    expect(_protocol).toStrictEqual(protocol)
    expect(_protocolClient).toStrictEqual(protocolClient)
    expect(_protocolServer).toStrictEqual(protocolServer)
    expect(_server).toStrictEqual(server)
    expect(_type).toStrictEqual(type)
    expect(_typeDefault).toStrictEqual(typeDefault)
    expect(_wsTransport).toStrictEqual(wsTransport)
  })
})
