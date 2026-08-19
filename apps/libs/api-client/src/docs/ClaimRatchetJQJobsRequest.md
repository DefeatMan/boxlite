# ClaimRatchetJQJobsRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**limit** | **number** | How many jobs to hand over at most — the executor’s remaining concurrency budget. Capped by the server’s own batch size. Omitting it asks for a full batch. | [optional] [default to undefined]
**ignoreLeaseExpire** | **boolean** | Set on the first claim after the runner starts. Takes back its interrupted jobs without waiting out leases granted to the process that died, and without spending a retry round on the restart. | [optional] [default to false]

## Example

```typescript
import { ClaimRatchetJQJobsRequest } from './api';

const instance: ClaimRatchetJQJobsRequest = {
    limit,
    ignoreLeaseExpire,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
