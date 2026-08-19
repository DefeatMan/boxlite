# ReportRatchetJQJobRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**status** | **string** | The business result the executor reached | [default to undefined]
**outParams** | **{ [key: string]: any; }** | The job output, shaped by the job type. Omitted when the job produces nothing. | [optional] [default to undefined]
**errMsg** | **string** | Why the run failed, in the executor’s own words. Sent with status \&quot;failed\&quot;; omitted for a run that produced an outcome. Stored truncated. | [optional] [default to undefined]

## Example

```typescript
import { ReportRatchetJQJobRequest } from './api';

const instance: ReportRatchetJQJobRequest = {
    status,
    outParams,
    errMsg,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
