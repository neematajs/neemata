import nmtjs from 'nmtjs'
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
import { describe, expect, it } from 'vitest'

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
  })
})
