# ReportRatchetJQJobResponse


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**accepted** | **boolean** | Whether the outcome was recorded. False means this executor held no running job of that id — a repeat report, or a job whose lease it had already lost. | [default to undefined]

## Example

```typescript
import { ReportRatchetJQJobResponse } from './api';

const instance: ReportRatchetJQJobResponse = {
    accepted,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
