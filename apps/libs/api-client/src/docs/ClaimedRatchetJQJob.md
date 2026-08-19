# ClaimedRatchetJQJob


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **string** | The ID of the job, which its outcome is reported against | [default to undefined]
**type** | **string** | The job type to run this job, matching the name the executor registers it under | [default to undefined]
**resourceId** | **string** | The resource the job acts on | [default to undefined]
**inParams** | **{ [key: string]: any; }** | The job input, shaped by the job type | [optional] [default to undefined]
**leaseExpiresAt** | **Date** | When this claim on the job lapses. The executor must stop running it by then: past this moment the job is claimable again, so anything still working on it is racing whoever picked it up next. | [default to undefined]

## Example

```typescript
import { ClaimedRatchetJQJob } from './api';

const instance: ClaimedRatchetJQJob = {
    id,
    type,
    resourceId,
    inParams,
    leaseExpiresAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
